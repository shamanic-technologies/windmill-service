import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateDAG, type DAG } from "../lib/dag-validator.js";
import { dagToOpenFlow } from "../lib/dag-to-openflow.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  DeployWorkflowsSchema,
  GenerateWorkflowSchema,
  BestWorkflowQuerySchema,
} from "../schemas.js";
import {
  generateWorkflow,
  GenerationValidationError,
} from "../lib/workflow-generator.js";
import { computeDAGSignature } from "../lib/dag-signature.js";
import { pickSignatureName } from "../lib/signature-words.js";
import { extractHttpEndpoints } from "../lib/extract-http-endpoints.js";
import { fetchProviderRequirements, fetchAnthropicKey } from "../lib/key-service-client.js";
import { fetchRunCosts, fetchEmailStats } from "../lib/stats-client.js";

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

// POST /workflows/generate — Generate a workflow from natural language
router.post("/workflows/generate", requireApiKey, async (req, res) => {
  try {
    const body = GenerateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const userId = res.locals.userId as string;
    const runId = res.locals.runId as string;
    const identity = { orgId, userId, runId };

    const { key: anthropicApiKey } = await fetchAnthropicKey({ orgId, userId, runId });

    const generated = await generateWorkflow(
      { description: body.description, hints: body.hints, style: body.style },
      anthropicApiKey,
      identity,
    );

    const dag = generated.dag as DAG;
    const signature = computeDAGSignature(generated.dag);

    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, orgId),
          eq(workflows.signature, signature),
        )
      );

    type DeployResult = {
      id: string;
      name: string;
      category: string;
      channel: string;
      audienceType: string;
      tags: string[];
      signature: string;
      signatureName: string;
      action: "created" | "updated";
    };

    let result: DeployResult;

    if (existing) {
      const openFlow = dagToOpenFlow(dag, existing.name);
      const client = getWindmillClient();
      if (client && existing.windmillFlowPath) {
        try {
          await client.updateFlow(existing.windmillFlowPath, {
            summary: existing.name,
            description: generated.description,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflows] generate: failed to update Windmill flow:", err);
        }
      }

      const [updated] = await db
        .update(workflows)
        .set({
          description: generated.description,
          category: generated.category,
          channel: generated.channel,
          audienceType: generated.audienceType,
          dag: generated.dag,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existing.id))
        .returning();

      result = {
        id: updated.id,
        name: updated.name,
        category: updated.category,
        channel: updated.channel,
        audienceType: updated.audienceType,
        tags: (updated.tags as string[]) ?? [],
        signature: updated.signature,
        signatureName: updated.signatureName,
        action: "updated",
      };
    } else {
      let signatureName: string;
      let displayName: string;
      let styleName: string | null = null;
      let humanId: string | null = null;
      let brandId: string | null = null;

      if (body.style) {
        styleName = body.style.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        // Count existing workflows with same (orgId, styleName) for versioning
        const sameStyle = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.orgId, orgId),
              eq(workflows.styleName, styleName),
            )
          );
        const version = sameStyle.length + 1;

        signatureName = `${styleName}-v${version}`;
        displayName = `${body.style.name} v${version}`;

        if (body.style.type === "human" && body.style.humanId) {
          humanId = body.style.humanId;
        }
        if (body.style.type === "brand" && body.style.brandId) {
          brandId = body.style.brandId;
        }
      } else {
        signatureName = pickSignatureName(signature, usedNames);
        displayName = `${generated.category}-${generated.channel}-${generated.audienceType}-${signatureName}`;
      }

      const name = `${generated.category}-${generated.channel}-${generated.audienceType}-${signatureName}`;
      const openFlow = dagToOpenFlow(dag, name);
      const flowPath = generateFlowPath(orgId, name);
      const client = getWindmillClient();

      if (client) {
        try {
          await client.createFlow({
            path: flowPath,
            summary: name,
            description: generated.description,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflows] generate: failed to create Windmill flow:", err);
        }
      }

      const [created] = await db
        .insert(workflows)
        .values({
          orgId,
          name,
          displayName,
          description: generated.description,
          category: generated.category,
          channel: generated.channel,
          audienceType: generated.audienceType,
          signature,
          signatureName,
          dag: generated.dag,
          windmillFlowPath: flowPath,
          humanId,
          brandId,
          styleName,
        })
        .returning();

      result = {
        id: created.id,
        name: created.name,
        category: created.category,
        channel: created.channel,
        audienceType: created.audienceType,
        tags: (created.tags as string[]) ?? [],
        signature: created.signature,
        signatureName: created.signatureName,
        action: "created",
      };
    }

    res.json({
      workflow: result,
      dag: generated.dag,
      category: generated.category,
      channel: generated.channel,
      audienceType: generated.audienceType,
      generatedDescription: generated.description,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    if (err instanceof GenerationValidationError) {
      res.status(422).json({
        error: err.message,
        details: err.validationErrors,
      });
      return;
    }
    if (err instanceof Error && err.message.startsWith("key-service error:")) {
      console.error("[workflows] generate: key-service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[workflows] GENERATE error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
});

// POST /workflows — Create a new workflow
router.post("/workflows", requireApiKey, async (req, res) => {
  try {
    const body = CreateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const dag = body.dag as DAG;

    // Validate the DAG
    const validation = validateDAG(dag);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid DAG", details: validation.errors });
      return;
    }

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, body.name);
    const flowPath = generateFlowPath(orgId, body.name);

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

    // Compute signature
    const signature = computeDAGSignature(body.dag);
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));
    const signatureName = pickSignatureName(signature, usedNames);

    // Store in DB
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId,
        brandId: body.brandId,
        campaignId: body.campaignId,
        subrequestId: body.subrequestId,
        name: body.name,
        description: body.description,
        category: body.category,
        channel: body.channel,
        audienceType: body.audienceType,
        tags: body.tags ?? [],
        signature,
        signatureName,
        dag: body.dag,
        windmillFlowPath: flowPath,
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

// PUT /workflows/deploy — Batch upsert workflows by (orgId + signature)
router.put("/workflows/deploy", requireApiKey, async (req, res) => {
  try {
    const body = DeployWorkflowsSchema.parse(req.body);
    const orgId = res.locals.orgId as string;

    // Validate ALL DAGs first — reject if any are invalid
    const dagErrors: { index: number; errors: unknown[] }[] = [];
    for (let i = 0; i < body.workflows.length; i++) {
      const validation = validateDAG(body.workflows[i].dag as DAG);
      if (!validation.valid) {
        dagErrors.push({ index: i, errors: validation.errors ?? [] });
      }
    }
    if (dagErrors.length > 0) {
      res.status(400).json({ error: "Invalid DAGs", details: dagErrors });
      return;
    }

    // Fetch all existing signatureNames for this orgId to avoid collisions
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    const results: { id: string; name: string; category: string; channel: string; audienceType: string; tags: string[]; signature: string; signatureName: string; action: "created" | "updated" }[] = [];

    for (const wf of body.workflows) {
      const dag = wf.dag as DAG;
      const signature = computeDAGSignature(wf.dag);

      // Check if workflow already exists for this (orgId, signature)
      const [existing] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, orgId),
            eq(workflows.signature, signature),
          )
        );

      if (existing) {
        // Same DAG already deployed — update metadata
        const openFlow = dagToOpenFlow(dag, existing.name);
        const client = getWindmillClient();

        if (client && existing.windmillFlowPath) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: existing.name,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflows] deploy: failed to update Windmill flow:", err);
          }
        }

        const updatedTags = wf.tags ?? (existing.tags as string[]) ?? [];
        const [updated] = await db
          .update(workflows)
          .set({
            orgId,
            description: wf.description ?? existing.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: updatedTags,
            dag: wf.dag,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, existing.id))
          .returning();

        results.push({
          id: updated.id,
          name: updated.name,
          category: updated.category,
          channel: updated.channel,
          audienceType: updated.audienceType,
          tags: (updated.tags as string[]) ?? [],
          signature: updated.signature,
          signatureName: updated.signatureName,
          action: "updated",
        });
      } else {
        // New DAG — generate signatureName and build name
        const signatureName = pickSignatureName(signature, usedNames);
        usedNames.add(signatureName);

        const name = `${wf.category}-${wf.channel}-${wf.audienceType}-${signatureName}`;
        const openFlow = dagToOpenFlow(dag, name);
        const flowPath = generateFlowPath(orgId, name);
        const client = getWindmillClient();

        if (client) {
          try {
            await client.createFlow({
              path: flowPath,
              summary: name,
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
            orgId,
            name,
            displayName: name,
            description: wf.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: wf.tags ?? [],
            signature,
            signatureName,
            dag: wf.dag,
            windmillFlowPath: flowPath,
          })
          .returning();

        results.push({
          id: created.id,
          name: created.name,
          category: created.category,
          channel: created.channel,
          audienceType: created.audienceType,
          tags: (created.tags as string[]) ?? [],
          signature: created.signature,
          signatureName: created.signatureName,
          action: "created",
        });
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

// GET /workflows/best — Get the best-performing workflow by cost efficiency
router.get("/workflows/best", requireApiKey, async (req, res) => {
  try {
    const query = BestWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, category, channel, audienceType, objective } = query.data;
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    // 1. Get all workflows matching the dimensions (all filters optional)
    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (category) conditions.push(eq(workflows.category, category));
    if (channel) conditions.push(eq(workflows.channel, channel));
    if (audienceType) conditions.push(eq(workflows.audienceType, audienceType));

    const matchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    if (matchingWorkflows.length === 0) {
      res.status(404).json({ error: "No workflows found matching the criteria" });
      return;
    }

    // 2. For each workflow, get completed runs and extract external runIds
    const workflowRunsByWfId: Record<string, string[]> = {};
    const allRunIds: string[] = [];

    for (const wf of matchingWorkflows) {
      const runs = await db
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, wf.id),
            eq(workflowRuns.status, "completed"),
          )
        );

      const runIds = runs
        .map((r) => r.runId)
        .filter((id): id is string => id !== null);

      workflowRunsByWfId[wf.id] = runIds;
      allRunIds.push(...runIds);
    }

    if (allRunIds.length === 0) {
      res.status(404).json({
        error: "No completed runs found for any matching workflow",
      });
      return;
    }

    // 3. Batch fetch costs from runs-service
    const runCosts = await fetchRunCosts(allRunIds, identity);
    const costByRunId = new Map(
      runCosts.map((c) => [c.runId, c.totalCostInUsdCents])
    );

    // 4. Per-workflow: compute cost + fetch email stats
    const workflowScores: Array<{
      workflow: (typeof matchingWorkflows)[0];
      totalCost: number;
      totalOutcomes: number;
      costPerOutcome: number | null;
      completedRuns: number;
    }> = [];

    for (const wf of matchingWorkflows) {
      const runIds = workflowRunsByWfId[wf.id];
      if (!runIds || runIds.length === 0) continue;

      const totalCost = runIds.reduce(
        (sum, id) => sum + (costByRunId.get(id) ?? 0),
        0
      );

      const stats = await fetchEmailStats(runIds, identity);
      const outcomes =
        objective === "replies"
          ? (stats.transactional?.replied ?? 0) + (stats.broadcast?.replied ?? 0)
          : (stats.transactional?.clicked ?? 0) + (stats.broadcast?.clicked ?? 0);

      const costPerOutcome = outcomes > 0 ? totalCost / outcomes : null;

      workflowScores.push({
        workflow: wf,
        totalCost,
        totalOutcomes: outcomes,
        costPerOutcome,
        completedRuns: runIds.length,
      });
    }

    if (workflowScores.length === 0) {
      res.status(404).json({ error: "No workflows with completed runs found" });
      return;
    }

    // 5. Sort: lowest costPerOutcome first; null last (fallback: most runs)
    workflowScores.sort((a, b) => {
      if (a.costPerOutcome !== null && b.costPerOutcome !== null) {
        return a.costPerOutcome - b.costPerOutcome;
      }
      if (a.costPerOutcome !== null) return -1;
      if (b.costPerOutcome !== null) return 1;
      return b.completedRuns - a.completedRuns;
    });

    // 6. Return the best workflow
    const best = workflowScores[0];
    res.json({
      workflow: {
        id: best.workflow.id,
        name: best.workflow.name,
        category: best.workflow.category,
        channel: best.workflow.channel,
        audienceType: best.workflow.audienceType,
        signature: best.workflow.signature,
        signatureName: best.workflow.signatureName,
      },
      dag: best.workflow.dag,
      stats: {
        totalCostInUsdCents: best.totalCost,
        totalOutcomes: best.totalOutcomes,
        costPerOutcome: best.costPerOutcome,
        completedRuns: best.completedRuns,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    if (
      err instanceof Error &&
      (err.message.includes("RUNS_SERVICE_URL") ||
        err.message.includes("EMAIL_GATEWAY_SERVICE_URL") ||
        err.message.startsWith("email-gateway-service error:"))
    ) {
      console.error("[workflows] best: external service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[workflows] GET best error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows — List workflows
router.get("/workflows", requireApiKey, async (req, res) => {
  try {
    const { orgId, brandId, humanId, campaignId, category, channel, audienceType, tag } = req.query;

    const conditions: ReturnType<typeof eq>[] = [];

    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflows.orgId, orgId));
    }
    if (brandId && typeof brandId === "string") {
      conditions.push(eq(workflows.brandId, brandId));
    }
    if (humanId && typeof humanId === "string") {
      conditions.push(eq(workflows.humanId, humanId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflows.campaignId, campaignId));
    }
    if (category && typeof category === "string") {
      conditions.push(eq(workflows.category, category));
    }
    if (channel && typeof channel === "string") {
      conditions.push(eq(workflows.channel, channel));
    }
    if (audienceType && typeof audienceType === "string") {
      conditions.push(eq(workflows.audienceType, audienceType));
    }
    if (tag && typeof tag === "string") {
      conditions.push(sql`${workflows.tags} @> ${JSON.stringify([tag])}::jsonb`);
    }

    const results = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

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

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    res.json(formatWorkflow(workflow));
  } catch (err) {
    console.error("[workflows] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id/required-providers — Compute required BYOK providers for a workflow
router.get("/workflows/:id/required-providers", requireApiKey, async (req, res) => {
  try {
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const dag = workflow.dag as DAG;
    const endpoints = extractHttpEndpoints(dag);

    if (endpoints.length === 0) {
      res.json({ endpoints: [], requirements: [], providers: [] });
      return;
    }

    const result = await fetchProviderRequirements(endpoints, identity);

    res.json({
      endpoints,
      requirements: result.requirements,
      providers: result.providers,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("key-service error:")) {
      console.error("[workflows] required-providers: key-service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[workflows] required-providers error:", err);
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

    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.tags !== undefined) updates.tags = body.tags;

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
      updates.signature = computeDAGSignature(body.dag);

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

// DELETE /workflows/:id — Hard delete
router.delete("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing) {
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
      .delete(workflows)
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

    if (!workflow) {
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
