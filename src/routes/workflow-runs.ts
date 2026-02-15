import { Router } from "express";
import { eq, and, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { getWindmillClient } from "../lib/windmill-client.js";
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

      // Look up workflow by (orgId + name)
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, body.orgId),
            eq(workflows.name, req.params.name),
            rawSql`${workflows.status} != 'deleted'`
          )
        );

      if (!workflow) {
        res.status(404).json({
          error: `Workflow "${req.params.name}" not found for org "${body.orgId}"`,
        });
        return;
      }

      if (!workflow.windmillFlowPath) {
        res
          .status(400)
          .json({ error: "Workflow has no Windmill flow path" });
        return;
      }

      // Run in Windmill
      let windmillJobId: string | null = null;
      const client = getWindmillClient();
      if (client) {
        try {
          windmillJobId = await client.runFlow(
            workflow.windmillFlowPath,
            body.inputs ?? {}
          );
        } catch (err) {
          console.error(
            "[workflow-runs] Failed to run flow in Windmill:",
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
          orgId: workflow.orgId,
          campaignId: workflow.campaignId,
          subrequestId: workflow.subrequestId,
          runId: body.runId,
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
      console.error("[workflow-runs] POST execute-by-name error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /workflows/:id/execute — Execute a workflow
router.post("/workflows/:id/execute", requireApiKey, async (req, res) => {
  try {
    const body = ExecuteWorkflowSchema.parse(req.body ?? {});

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow || workflow.status === "deleted") {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (!workflow.windmillFlowPath) {
      res
        .status(400)
        .json({ error: "Workflow has no Windmill flow path" });
      return;
    }

    // Run in Windmill
    let windmillJobId: string | null = null;
    const client = getWindmillClient();
    if (client) {
      try {
        windmillJobId = await client.runFlow(
          workflow.windmillFlowPath,
          body.inputs ?? {}
        );
      } catch (err) {
        console.error("[workflow-runs] Failed to run flow in Windmill:", err);
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
        orgId: workflow.orgId,
        campaignId: workflow.campaignId,
        subrequestId: workflow.subrequestId,
        runId: body.runId,
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
    console.error("[workflow-runs] POST execute error:", err);
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
              error: success ? null : String(job.result ?? "Unknown error"),
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
          "[workflow-runs] Failed to poll Windmill job:",
          err
        );
        // Return what we have in DB
      }
    }

    res.json(formatRun(run));
  } catch (err) {
    console.error("[workflow-runs] GET by id error:", err);
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
    console.error("[workflow-runs] GET list error:", err);
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
          console.error("[workflow-runs] Failed to cancel Windmill job:", err);
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
    console.error("[workflow-runs] POST cancel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
