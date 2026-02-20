import { Router } from "express";
import { eq, and, sql as rawSql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateDAG, type DAG } from "../lib/dag-validator.js";
import { dagToOpenFlow } from "../lib/dag-to-openflow.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  DeployWorkflowsSchema,
} from "../schemas.js";

const router = Router();

function formatWorkflow(w: typeof workflows.$inferSelect) {
  return {
    ...w,
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}

function generateFlowPath(scope: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${slug}`;
}

// POST /workflows — Create a new workflow
router.post("/workflows", requireApiKey, async (req, res) => {
  try {
    const body = CreateWorkflowSchema.parse(req.body);
    const dag = body.dag as DAG;

    // Validate the DAG
    const validation = validateDAG(dag);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid DAG", details: validation.errors });
      return;
    }

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, body.name);
    const flowPath = generateFlowPath(body.orgId, body.name);

    // Push to Windmill (if configured)
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: body.name,
          description: body.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflows] Failed to create flow in Windmill:", err);
      }
    }

    // Store in DB
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId: body.orgId,
        brandId: body.brandId,
        campaignId: body.campaignId,
        subrequestId: body.subrequestId,
        name: body.name,
        description: body.description,
        dag: body.dag,
        windmillFlowPath: flowPath,
        status: "active",
      })
      .returning();

    res.status(201).json(formatWorkflow(workflow));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflows] POST error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/deploy — Batch upsert workflows by (appId + name)
router.put("/workflows/deploy", requireApiKey, async (req, res) => {
  try {
    const body = DeployWorkflowsSchema.parse(req.body);

    // Validate ALL DAGs first — reject if any are invalid
    const dagErrors: { name: string; errors: unknown[] }[] = [];
    for (const wf of body.workflows) {
      const validation = validateDAG(wf.dag as DAG);
      if (!validation.valid) {
        dagErrors.push({ name: wf.name, errors: validation.errors ?? [] });
      }
    }
    if (dagErrors.length > 0) {
      res.status(400).json({ error: "Invalid DAGs", details: dagErrors });
      return;
    }

    const results: { id: string; name: string; displayName: string | null; category: string | null; action: "created" | "updated" }[] = [];

    for (const wf of body.workflows) {
      const dag = wf.dag as DAG;
      const openFlow = dagToOpenFlow(dag, wf.name);
      const flowPath = generateFlowPath(body.appId, wf.name);
      const client = getWindmillClient();

      // Check if workflow already exists for this (appId, name)
      const [existing] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.appId, body.appId),
            eq(workflows.name, wf.name),
            rawSql`${workflows.status} != 'deleted'`
          )
        );

      if (existing) {
        // Update existing workflow
        if (client && existing.windmillFlowPath) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: wf.name,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflows] deploy: failed to update Windmill flow:", err);
          }
        }

        const [updated] = await db
          .update(workflows)
          .set({
            displayName: wf.displayName ?? existing.displayName,
            description: wf.description ?? existing.description,
            category: wf.category ?? existing.category,
            dag: wf.dag,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, existing.id))
          .returning();

        results.push({ id: updated.id, name: updated.name, displayName: updated.displayName, category: updated.category, action: "updated" });
      } else {
        // Create new workflow
        if (client) {
          try {
            await client.createFlow({
              path: flowPath,
              summary: wf.name,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflows] deploy: failed to create Windmill flow:", err);
          }
        }

        const [created] = await db
          .insert(workflows)
          .values({
            appId: body.appId,
            orgId: body.appId,
            name: wf.name,
            displayName: wf.displayName ?? null,
            description: wf.description,
            category: wf.category ?? null,
            dag: wf.dag,
            windmillFlowPath: flowPath,
            status: "active",
          })
          .returning();

        results.push({ id: created.id, name: created.name, displayName: created.displayName, category: created.category, action: "created" });
      }
    }

    res.json({ workflows: results });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflows] PUT deploy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows — List workflows
router.get("/workflows", requireApiKey, async (req, res) => {
  try {
    const { orgId, appId, brandId, campaignId, category, status } = req.query;

    if (!orgId || typeof orgId !== "string") {
      res.status(400).json({ error: "orgId query parameter is required" });
      return;
    }

    const conditions = [
      eq(workflows.orgId, orgId),
    ];

    if (appId && typeof appId === "string") {
      conditions.push(eq(workflows.appId, appId));
    }
    if (brandId && typeof brandId === "string") {
      conditions.push(eq(workflows.brandId, brandId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflows.campaignId, campaignId));
    }
    if (category && typeof category === "string") {
      conditions.push(eq(workflows.category, category));
    }
    if (status && typeof status === "string") {
      conditions.push(eq(workflows.status, status));
    } else {
      // Exclude deleted by default
      conditions.push(rawSql`${workflows.status} != 'deleted'`);
    }

    const results = await db
      .select()
      .from(workflows)
      .where(and(...conditions));

    res.json({ workflows: results.map(formatWorkflow) });
  } catch (err) {
    console.error("[workflows] GET list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id — Get one workflow
router.get("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow || workflow.status === "deleted") {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    res.json(formatWorkflow(workflow));
  } catch (err) {
    console.error("[workflows] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/:id — Update a workflow
router.put("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const body = UpdateWorkflowSchema.parse(req.body);

    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing || existing.status === "deleted") {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    if (body.dag) {
      const dag = body.dag as DAG;
      const validation = validateDAG(dag);
      if (!validation.valid) {
        res
          .status(400)
          .json({ error: "Invalid DAG", details: validation.errors });
        return;
      }

      updates.dag = body.dag;

      // Re-translate and update in Windmill
      const flowName = body.name ?? existing.name;
      const openFlow = dagToOpenFlow(dag, flowName);

      if (existing.windmillFlowPath) {
        const client = getWindmillClient();
        if (client) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: flowName,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error(
              "[workflows] Failed to update flow in Windmill:",
              err
            );
          }
        }
      }
    }

    const [updated] = await db
      .update(workflows)
      .set(updates)
      .where(eq(workflows.id, req.params.id))
      .returning();

    res.json(formatWorkflow(updated));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflows] PUT error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workflows/:id — Soft delete
router.delete("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing || existing.status === "deleted") {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Delete from Windmill (if configured)
    if (existing.windmillFlowPath) {
      const client = getWindmillClient();
      if (client) {
        try {
          await client.deleteFlow(existing.windmillFlowPath);
        } catch (err) {
          console.error(
            "[workflows] Failed to delete flow in Windmill:",
            err
          );
        }
      }
    }

    await db
      .update(workflows)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(workflows.id, req.params.id));

    res.json({ message: "Workflow deleted" });
  } catch (err) {
    console.error("[workflows] DELETE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /workflows/:id/validate — Validate DAG only
router.post("/workflows/:id/validate", requireApiKey, async (req, res) => {
  try {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow || workflow.status === "deleted") {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const validation = validateDAG(workflow.dag as DAG);
    res.json(validation);
  } catch (err) {
    console.error("[workflows] VALIDATE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
