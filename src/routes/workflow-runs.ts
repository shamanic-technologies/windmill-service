import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import { collectServiceEnvs } from "../lib/service-envs.js";
import { createRun } from "../lib/runs-client.js";
import { ExecuteWorkflowSchema, ExecuteByNameSchema } from "../schemas.js";

const router = Router();

function formatRun(r: typeof workflowRuns.$inferSelect) {
  return {
    ...r,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

// POST /workflows/by-name/:name/execute — Execute a workflow by name
router.post(
  "/workflows/by-name/:name/execute",
  requireApiKey,
  async (req, res) => {
    try {
      const body = ExecuteByNameSchema.parse(req.body);
      const orgId = res.locals.orgId as string;

      // Look up workflow by name — only active workflows can be executed
      let [workflow] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.name, req.params.name),
            eq(workflows.status, "active"),
          )
        );

      if (!workflow) {
        // Check if deprecated — follow upgrade chain to find active replacement
        const [deprecated] = await db
          .select()
          .from(workflows)
          .where(eq(workflows.name, req.params.name));

        if (deprecated && deprecated.status === "deprecated") {
          // Follow upgrade chain to the latest active version
          let currentId = deprecated.upgradedTo;
          let depth = 0;
          while (currentId && depth < 10) {
            const [candidate] = await db
              .select()
              .from(workflows)
              .where(eq(workflows.id, currentId));

            if (!candidate) break;
            if (candidate.status === "active") {
              workflow = candidate;
              console.log(
                `[workflow-service] Execute by name: "${req.params.name}" is deprecated, following upgrade chain to "${candidate.name}" (${candidate.id})`,
              );
              break;
            }
            currentId = candidate.upgradedTo;
            depth++;
          }

          if (!workflow) {
            // Dead end — no active workflow at the end of the chain
            let upgradedToName: string | null = null;
            if (deprecated.upgradedTo) {
              const [replacement] = await db
                .select()
                .from(workflows)
                .where(eq(workflows.id, deprecated.upgradedTo));
              upgradedToName = replacement?.name ?? null;
            }
            res.status(410).json({
              error: "Workflow has been deprecated",
              upgradedTo: deprecated.upgradedTo,
              upgradedToName,
            });
            return;
          }
        } else {
          console.warn(
            `[workflow-service] Execute by name: workflow "${req.params.name}" not found (no active workflow with this name)`,
          );
          res.status(404).json({
            error: `Workflow "${req.params.name}" not found`,
          });
          return;
        }
      }

      if (!workflow.windmillFlowPath) {
        res
          .status(400)
          .json({ error: "Workflow has no Windmill flow path" });
        return;
      }

      const userId = res.locals.userId as string;
      const callerRunId = res.locals.runId as string;

      // Create a child run in runs-service (links to caller's run via parentRunId)
      let ownRunId: string | null = null;
      try {
        const { runId: newRunId } = await createRun({
          parentRunId: callerRunId,
          orgId,
          userId,
          taskName: "execute-workflow",
          workflowName: workflow.name,
        });
        ownRunId = newRunId;
      } catch (err) {
        console.error("[workflow-service] Failed to create run in runs-service:", err);
        res.status(502).json({ error: "Failed to create run in runs-service" });
        return;
      }

      // Run in Windmill — inject orgId, userId, and our own runId so nodes can access them
      let windmillJobId: string | null = null;
      const client = getWindmillClient();
      if (client) {
        try {
          const flowInputs = { ...body.inputs, orgId, userId, runId: ownRunId, serviceEnvs: collectServiceEnvs() };
          windmillJobId = await client.runFlow(
            workflow.windmillFlowPath,
            flowInputs
          );
        } catch (err) {
          console.error(
            "[workflow-service] Failed to run flow in Windmill:",
            err
          );
          res
            .status(502)
            .json({ error: "Failed to start workflow in Windmill" });
          return;
        }
      }

      // Create workflow run in DB
      const [run] = await db
        .insert(workflowRuns)
        .values({
          workflowId: workflow.id,
          orgId,
          userId,
          campaignId: workflow.campaignId,
          subrequestId: workflow.subrequestId,
          runId: ownRunId,
          windmillJobId,
          windmillWorkspace: workflow.windmillWorkspace,
          status: "queued",
          inputs: body.inputs,
        })
        .returning();

      console.log(
        `[workflow-service] Workflow "${workflow.name}" execution started: runId=${ownRunId}, windmillJobId=${windmillJobId ?? "none"}`,
      );

      res.status(201).json(formatRun(run));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "ZodError") {
        res.status(400).json({ error: "Validation error", details: err });
        return;
      }
      console.error("[workflow-service] POST execute-by-name error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /workflows/:id/execute — Execute a workflow
router.post("/workflows/:id/execute", requireApiKey, async (req, res) => {
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
        res.status(410).json({
          error: "Workflow has been deprecated",
          upgradedTo: deprecated.upgradedTo,
        });
        return;
      }

      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (!workflow.windmillFlowPath) {
      res
        .status(400)
        .json({ error: "Workflow has no Windmill flow path" });
      return;
    }

    const executeUserId = res.locals.userId as string;
    const callerRunId = res.locals.runId as string;

    // Create a child run in runs-service (links to caller's run via parentRunId)
    let ownRunId: string | null = null;
    try {
      const { runId: newRunId } = await createRun({
        parentRunId: callerRunId,
        orgId,
        userId: executeUserId,
        taskName: "execute-workflow",
        workflowName: workflow.name,
      });
      ownRunId = newRunId;
    } catch (err) {
      console.error("[workflow-service] Failed to create run in runs-service:", err);
      res.status(502).json({ error: "Failed to create run in runs-service" });
      return;
    }

    // Run in Windmill — inject orgId, userId, and our own runId so nodes can access them
    let windmillJobId: string | null = null;
    const client = getWindmillClient();
    if (client) {
      try {
        const flowInputs = { ...body.inputs, orgId, userId: executeUserId, runId: ownRunId, serviceEnvs: collectServiceEnvs() };
        windmillJobId = await client.runFlow(
          workflow.windmillFlowPath,
          flowInputs
        );
      } catch (err) {
        console.error("[workflow-service] Failed to run flow in Windmill:", err);
        res
          .status(502)
          .json({ error: "Failed to start workflow in Windmill" });
        return;
      }
    }

    // Create workflow run in DB
    const [run] = await db
      .insert(workflowRuns)
      .values({
        workflowId: workflow.id,
        orgId,
        userId: executeUserId,
        campaignId: workflow.campaignId,
        subrequestId: workflow.subrequestId,
        runId: ownRunId,
        windmillJobId,
        windmillWorkspace: workflow.windmillWorkspace,
        status: "queued",
        inputs: body.inputs,
      })
      .returning();

    res.status(201).json(formatRun(run));
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
    const { workflowId, orgId, campaignId, status } = req.query;

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

    const [updated] = await db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, run.id))
      .returning();

    res.json(formatRun(updated));
  } catch (err) {
    console.error("[workflow-service] POST cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
