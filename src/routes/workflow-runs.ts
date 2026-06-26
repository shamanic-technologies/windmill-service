import { Router, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey, requireExecutionHeaders } from "../middleware/auth.js";
import { executeRateLimit } from "../middleware/rate-limit.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import { isAmbiguousWindmillDispatchError } from "../lib/windmill-client.js";
import { collectServiceEnvs } from "../lib/service-envs.js";
import { createRun, closeRun } from "../lib/runs-client.js";
import { ExecuteWorkflowSchema, ExecuteByNameSchema } from "../schemas.js";
import { parseWindmillError } from "../lib/error-parser.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  attributionContextToHeaders,
  buildCampaignAttributionContext,
} from "../lib/attribution-context.js";
import {
  attachRunsServiceRun,
  markExecutionDispatchFailed,
  markExecutionDispatched,
  reserveCampaignExecution,
  resolveExecutionConflictPolicy,
  type ExecutionConflictPolicy,
} from "../lib/execution-admission.js";
const router = Router();

function formatRun(r: typeof workflowRuns.$inferSelect) {
  const base = {
    ...r,
    attributionContext: r.attributionContext ?? null,
    reservedAt: r.reservedAt?.toISOString() ?? null,
    dispatchStartedAt: r.dispatchStartedAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  };

  if (r.status === "failed" && r.error) {
    const parsed = parseWindmillError(r.error);
    return {
      ...base,
      errorSummary: {
        failedStep: parsed.failedStep,
        message: parsed.message,
        rootCause: parsed.rootCause,
      },
    };
  }

  return base;
}

type WorkflowRow = typeof workflows.$inferSelect;
type ExecuteBody = {
  inputs?: Record<string, unknown>;
  attributionContext?: Record<string, unknown>;
  conflictPolicy?: ExecutionConflictPolicy;
};

async function startWorkflowExecution(params: {
  req: Request;
  res: Response;
  workflow: WorkflowRow;
  body: ExecuteBody;
  traceEventName: "execute-by-id" | "execute-by-slug";
}): Promise<void> {
  const { req, res, workflow, body, traceEventName } = params;
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const callerRunId = res.locals.runId as string;
  const brandIds = (res.locals.brandIds as string[] | undefined) ?? [];
  const brandIdHeader = req.headers["x-brand-id"] as string | undefined;
  const campaignId = res.locals.campaignId as string;
  const featureSlug = res.locals.featureSlug as string;
  const conflictPolicy = resolveExecutionConflictPolicy(body.conflictPolicy);
  const attributionContext = buildCampaignAttributionContext({
    headers: req.headers,
    bodyAttributionContext: body.attributionContext,
    inputs: body.inputs,
    campaignId,
    brandIds,
    featureSlug,
  });
  const traceHeaders = {
    ...req.headers,
    ...attributionContextToHeaders(attributionContext),
  };

  const reservation = await reserveCampaignExecution({
    database: db,
    workflow,
    orgId,
    userId,
    campaignId,
    brandIds,
    featureSlug,
    inputs: body.inputs,
    attributionContext,
    conflictPolicy,
  });

  if (reservation.kind === "conflict") {
    traceEvent(callerRunId, {
      service: "workflow-service",
      event: "execution-conflict",
      detail: `Active workflow execution already exists for executionKey="${reservation.executionKey}" dbRunId=${reservation.run.id}`,
      data: { executionKey: reservation.executionKey, dbRunId: reservation.run.id, conflictPolicy },
    }, traceHeaders).catch(() => {});

    if (conflictPolicy === "reject") {
      res.status(409).json({
        error: "Active workflow execution already exists for this campaign",
        workflowRun: formatRun(reservation.run),
      });
      return;
    }

    res.status(200).json(formatRun(reservation.run));
    return;
  }

  let ownRunId: string | null = null;
  try {
    const createRunInput = {
      parentRunId: callerRunId,
      orgId,
      userId,
      taskName: "execute-workflow",
      workflowSlug: workflow.workflowSlug,
      campaignId,
      brandIdHeader,
      ...(attributionContext ? { attributionContext } : {}),
    };
    const { runId: newRunId } = await createRun(createRunInput);
    ownRunId = newRunId;
    await attachRunsServiceRun(db, reservation.run.id, ownRunId);
  } catch (err) {
    console.error("[workflow-service] Failed to create run in runs-service:", err);
    await markExecutionDispatchFailed(
      db,
      reservation.run.id,
      err instanceof Error ? err.message : String(err),
      false,
    );
    res.status(502).json({ error: "Failed to create run in runs-service" });
    return;
  }

  traceEvent(ownRunId, {
    service: "workflow-service",
    event: traceEventName,
    detail: `Executing workflow slug="${workflow.workflowSlug}" (id=${workflow.id}) for org=${orgId} campaign=${campaignId}`,
    data: { workflowSlug: workflow.workflowSlug, workflowId: workflow.id, orgId, campaignId, featureSlug },
  }, traceHeaders).catch(() => {});

  let windmillJobId: string | null = null;
  const client = getWindmillClient();
  if (client) {
    try {
      const attributionFlowInputs: Record<string, unknown> = {};
      if (attributionContext) {
        attributionFlowInputs.attributionContext = attributionContext;
        for (const field of [
          "goal",
          "brandProfileId",
          "profileId",
          "personaId",
          "goalId",
          "goalSlug",
          "optimizationGoal",
        ] as const) {
          if (typeof attributionContext[field] === "string") {
            attributionFlowInputs[field] = attributionContext[field];
          }
        }
      }
      const flowInputs = {
        ...body.inputs,
        orgId,
        userId,
        runId: ownRunId,
        workflowSlug: workflow.workflowSlug,
        campaignId,
        brandId: brandIdHeader,
        featureSlug,
        ...attributionFlowInputs,
        serviceEnvs: collectServiceEnvs(),
      };
      windmillJobId = await client.runFlow(
        workflow.windmillFlowPath as string,
        flowInputs
      );

      traceEvent(ownRunId, {
        service: "workflow-service",
        event: "windmill-dispatch",
        detail: `Dispatched to Windmill: jobId=${windmillJobId} flowPath="${workflow.windmillFlowPath}" inputKeys=${Object.keys(flowInputs).join(",")}`,
        data: { windmillJobId, flowPath: workflow.windmillFlowPath, inputKeys: Object.keys(flowInputs) },
      }, traceHeaders).catch(() => {});
    } catch (err) {
      const keepReservationActive = isAmbiguousWindmillDispatchError(err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[workflow-service] Failed to run flow in Windmill (${keepReservationActive ? "ambiguous" : "not-dispatched"}):`,
        err
      );
      const updated = await markExecutionDispatchFailed(
        db,
        reservation.run.id,
        errorMessage,
        keepReservationActive,
      );
      if (!keepReservationActive && ownRunId) {
        try {
          await closeRun(ownRunId, "failed", orgId);
        } catch (closeErr) {
          console.error(`[workflow-service] Failed to close dispatch-failed run ${ownRunId} in runs-service:`, closeErr);
        }
      }
      traceEvent(ownRunId, {
        service: "workflow-service",
        event: "windmill-dispatch",
        level: "error",
        detail: `Windmill dispatch failed (${keepReservationActive ? "ambiguous" : "not-dispatched"}): ${errorMessage}`,
        data: { flowPath: workflow.windmillFlowPath, error: errorMessage, ambiguous: keepReservationActive },
      }, traceHeaders).catch(() => {});
      res
        .status(502)
        .json({
          error: "Failed to start workflow in Windmill",
          dispatchState: keepReservationActive ? "ambiguous" : "not_dispatched",
          workflowRun: formatRun(updated),
        });
      return;
    }
  }

  const run = await markExecutionDispatched(db, reservation.run.id, windmillJobId);

  console.log(
    `[workflow-service] Workflow "${workflow.workflowSlug}" execution started: runId=${ownRunId}, windmillJobId=${windmillJobId ?? "none"}`,
  );

  traceEvent(ownRunId, {
    service: "workflow-service",
    event: "execute-queued",
    detail: `Workflow run queued: dbRunId=${run.id} windmillJobId=${windmillJobId ?? "none"} workflowSlug="${workflow.workflowSlug}"`,
    data: { dbRunId: run.id, windmillJobId, workflowSlug: workflow.workflowSlug },
  }, traceHeaders).catch(() => {});

  res.status(201).json(formatRun(run));
}

// POST /workflows/by-slug/:slug/execute — Execute a workflow by slug
router.post(
  "/workflows/by-slug/:slug/execute",
  requireApiKey,
  requireExecutionHeaders,
  executeRateLimit,
  async (req, res) => {
    try {
      const body = ExecuteByNameSchema.parse(req.body);
      const orgId = res.locals.orgId as string;

      // Look up workflow by slug — only active workflows can be executed
      type WorkflowRow = typeof workflows.$inferSelect;
      const activeRows = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.workflowSlug, req.params.slug),
            eq(workflows.status, "active"),
          )
        );
      let workflow: WorkflowRow | undefined = activeRows[0];

      if (!workflow) {
        // The slug has no active row. It may be a deprecated/older version of a
        // dynasty — callers (e.g. campaign-service) pass the stable dynasty slug,
        // which equals v1's workflow_slug, and v1 is deprecated after upgrades.
        // Resolve FORWARD to the dynasty's current active version via a direct
        // dynasty-slug lookup: O(1), no chain walk, no depth cap, no cycle risk.
        // (The previous walk capped at 10 hops and stranded dynasties with >11
        // versions on a 410 — live prod stuck-loop, the tectonic dynasty at v16.)
        const [known] = await db
          .select()
          .from(workflows)
          .where(eq(workflows.workflowSlug, req.params.slug));

        if (!known) {
          console.warn(
            `[workflow-service] Execute by slug: workflow "${req.params.slug}" not found (no workflow with this slug)`,
          );
          res.status(404).json({
            error: `Workflow "${req.params.slug}" not found`,
          });
          return;
        }

        // Exactly one active row exists per dynasty (partial unique index on
        // feature_slug+signature_name WHERE status='active'). Forks branch into a
        // NEW dynasty_slug, so the active row sharing THIS dynasty_slug is the
        // terminal version of the upgrade chain.
        const [activeInDynasty] = await db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.workflowDynastySlug, known.workflowDynastySlug),
              eq(workflows.status, "active"),
            )
          );

        if (!activeInDynasty) {
          // Dynasty fully deprecated — no live version to run.
          res.status(410).json({
            error: "Workflow has been deprecated",
            upgradedTo: null,
            upgradedToWorkflowSlug: null,
          });
          return;
        }

        workflow = activeInDynasty;
        if (workflow.workflowSlug !== req.params.slug) {
          console.log(
            `[workflow-service] Execute by slug: "${req.params.slug}" resolved forward to active dynasty version "${workflow.workflowSlug}" (${workflow.id})`,
          );
        }
      }

      traceEvent(res.locals.runId as string, { service: "workflow-service", event: "execute-by-slug", detail: `Resolved slug="${req.params.slug}" to workflow="${workflow.workflowSlug}" (${workflow.id})` }, req.headers).catch(() => {});

      if (!workflow.windmillFlowPath) {
        res
          .status(400)
          .json({ error: "Workflow has no Windmill flow path" });
        return;
      }

      await startWorkflowExecution({
        req,
        res,
        workflow,
        body,
        traceEventName: "execute-by-slug",
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "ZodError") {
        res.status(400).json({ error: "Validation error", details: err });
        return;
      }
      console.error("[workflow-service] POST execute-by-slug error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /workflows/:id/execute — Execute a workflow
router.post("/workflows/:id/execute", requireApiKey, requireExecutionHeaders, executeRateLimit, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = ExecuteWorkflowSchema.parse(req.body ?? {});
    const orgId = res.locals.orgId as string;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, req.params.id),
          eq(workflows.status, "active"),
        )
      );

    if (!workflow) {
      // Check if deprecated — return 410 with upgrade info instead of 404
      const [deprecated] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, req.params.id));

      if (deprecated && deprecated.status === "deprecated") {
        const [successor] = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.createdFromWorkflow, deprecated.id),
              eq(workflows.creationType, "upgrade"),
            )
          );
        res.status(410).json({
          error: "Workflow has been deprecated",
          upgradedTo: successor?.id ?? null,
        });
        return;
      }

      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    traceEvent(res.locals.runId as string, { service: "workflow-service", event: "execute-by-id", detail: `Resolved id="${req.params.id}" to workflow="${workflow.workflowSlug}"` }, req.headers).catch(() => {});

    if (!workflow.windmillFlowPath) {
      res
        .status(400)
        .json({ error: "Workflow has no Windmill flow path" });
      return;
    }

    await startWorkflowExecution({
      req,
      res,
      workflow,
      body,
      traceEventName: "execute-by-id",
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] POST execute error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs/:id — Get a workflow run (with live poll if running)
router.get("/workflow-runs/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    // If still active, poll Windmill for latest status
    const pollClient = getWindmillClient();
    if (
      pollClient &&
      (run.status === "queued" || run.status === "running") &&
      run.windmillJobId
    ) {
      try {
        const job = await pollClient.getJob(run.windmillJobId);

        if (!job.running) {
          const success = job.success ?? false;
          const newStatus = success ? "completed" : "failed";

          const [updated] = await db
            .update(workflowRuns)
            .set({
              status: newStatus,
              result: success ? (job.result as Record<string, unknown>) : null,
              error: success ? null : (typeof job.result === "string" ? job.result : JSON.stringify(job.result ?? "Unknown error")),
              completedAt: new Date(),
            })
            .where(eq(workflowRuns.id, run.id))
            .returning();

          const runTraceHeaders = {
            ...req.headers,
            ...attributionContextToHeaders(run.attributionContext as Record<string, unknown> | null | undefined),
          };
          traceEvent(run.runId ?? req.params.id, { service: "workflow-service", event: "job-completed", detail: `Run ${run.id} finished: status=${newStatus}, windmillJobId=${run.windmillJobId}` }, runTraceHeaders).catch(() => {});

          // Close the run in runs-service
          if (run.runId && run.orgId) {
            try {
              await closeRun(run.runId, newStatus, run.orgId);
            } catch (err) {
              console.error(`[workflow-service] Failed to close run ${run.runId} in runs-service:`, err);
            }
          }

          res.json(formatRun(updated));
          return;
        } else if (run.status === "queued") {
          const [updated] = await db
            .update(workflowRuns)
            .set({ status: "running", startedAt: new Date() })
            .where(eq(workflowRuns.id, run.id))
            .returning();

          res.json(formatRun(updated));
          return;
        }
      } catch (err) {
        console.error(
          "[workflow-service] Failed to poll Windmill job:",
          err
        );
        // Return what we have in DB
      }
    }

    res.json(formatRun(run));
  } catch (err) {
    console.error("[workflow-service] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs — List runs
router.get("/workflow-runs", requireApiKey, async (req, res) => {
  try {
    const { workflowId, orgId, campaignId, featureSlug, workflowSlug, status } = req.query;

    const conditions = [];

    if (workflowId && typeof workflowId === "string") {
      conditions.push(eq(workflowRuns.workflowId, workflowId));
    }
    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflowRuns.orgId, orgId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflowRuns.campaignId, campaignId));
    }
    if (featureSlug && typeof featureSlug === "string") {
      conditions.push(eq(workflowRuns.featureSlug, featureSlug));
    }
    if (workflowSlug && typeof workflowSlug === "string") {
      conditions.push(eq(workflowRuns.workflowSlug, workflowSlug));
    }
    if (status && typeof status === "string") {
      conditions.push(eq(workflowRuns.status, status));
    }

    const results =
      conditions.length > 0
        ? await db
            .select()
            .from(workflowRuns)
            .where(and(...conditions))
        : await db.select().from(workflowRuns);

    res.json({ workflowRuns: results.map(formatRun) });
  } catch (err) {
    console.error("[workflow-service] GET list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflow-runs/:id/debug — Get per-step execution details from Windmill
router.get("/workflow-runs/:id/debug", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    if (!run.windmillJobId) {
      res.status(400).json({ error: "Run has no Windmill job ID" });
      return;
    }

    const debugClient = getWindmillClient();
    if (!debugClient) {
      res.status(503).json({ error: "Windmill client not configured" });
      return;
    }

    const job = await debugClient.getJob(run.windmillJobId);

    res.json({
      runId: run.id,
      windmillJobId: run.windmillJobId,
      status: run.status,
      flowStatus: job.flow_status ?? null,
      result: job.result ?? null,
    });
  } catch (err) {
    console.error("[workflow-service] GET debug error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /workflow-runs/:id/cancel — Cancel a run
router.post("/workflow-runs/:id/cancel", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid run ID format" });
    return;
  }
  try {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, req.params.id));

    if (!run) {
      res.status(404).json({ error: "Workflow run not found" });
      return;
    }

    if (run.status !== "queued" && run.status !== "running") {
      res.status(400).json({ error: `Cannot cancel run with status: ${run.status}` });
      return;
    }

    // Cancel in Windmill
    if (run.windmillJobId) {
      const cancelClient = getWindmillClient();
      if (cancelClient) {
        try {
          await cancelClient.cancelJob(run.windmillJobId, "Cancelled by user");
        } catch (err) {
          console.error("[workflow-service] Failed to cancel Windmill job:", err);
        }
      }
    }

    const runTraceHeaders = {
      ...req.headers,
      ...attributionContextToHeaders(run.attributionContext as Record<string, unknown> | null | undefined),
    };
    traceEvent(run.runId ?? req.params.id, { service: "workflow-service", event: "run-cancelled", detail: `Run ${run.id} cancelled by user, windmillJobId=${run.windmillJobId ?? "none"}` }, runTraceHeaders).catch(() => {});

    const [updated] = await db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, run.id))
      .returning();

    // Close the run in runs-service as failed (cancelled = failed from runs-service perspective)
    if (run.runId && run.orgId) {
      try {
        await closeRun(run.runId, "failed", run.orgId);
      } catch (err) {
        console.error(`[workflow-service] Failed to close cancelled run ${run.runId} in runs-service:`, err);
      }
    }

    res.json(formatRun(updated));
  } catch (err) {
    console.error("[workflow-service] POST cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
