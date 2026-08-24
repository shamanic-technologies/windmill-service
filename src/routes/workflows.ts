import { Router } from "express";
import { eq, and, or, sql } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { db } from "../db/index.js";
import { workflows } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { validateDAG, type DAG } from "../lib/dag-validator.js";
import { dagToOpenFlow } from "../lib/dag-to-openflow.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  CreateWorkflowFromDescriptionSchema,
  UpgradeWorkflowFromDescriptionSchema,
  DynastyStatusUpdateSchema,
  WorkflowStatusUpdateSchema,
} from "../schemas.js";
import {
  generateWorkflow,
  GenerationValidationError,
} from "../lib/workflow-generator.js";
import { computeDAGSignature } from "../lib/dag-signature.js";
import { pickWorkflowDynastySignatureName } from "../lib/workflow-dynasty-signature-name.js";
import { extractHttpEndpoints } from "../lib/extract-http-endpoints.js";
import { fetchProviderRequirements } from "../lib/key-service-client.js";
import { enrichProvidersWithDomains } from "../lib/provider-domains.js";
import { extractTemplateRefs, validateTemplateContracts, type TemplateContractIssue, type TemplateRef } from "../lib/validate-template-contracts.js";
import { validateWorkflowEndpoints } from "../lib/validate-workflow-endpoints.js";
import { fetchSpecsForServices } from "../lib/api-registry-client.js";
import { fetchPromptTemplates } from "../lib/content-generation-client.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { validateClientDag } from "../lib/validate-client-dag.js";
import { computeWorkflowScores, aggregateSectionStats, handleExternalServiceError } from "../lib/workflow-scoring.js";
import { traceEvent } from "../lib/trace-event.js";
import { classifyWorkflowError } from "../lib/classify-workflow-error.js";
import { invalidateSpecWatcherCache } from "../lib/spec-watcher.js";
import { syncFlowToWindmill } from "../lib/startup-validator.js";
import { noteWorkflowWrite } from "../lib/periodic-cleanup.js";
import { resolveStatusFilter } from "../lib/status-filter.js";

const router = Router();

/**
 * Two background jobs deliberately have no timer of their own, so they have to
 * learn about writes from the traffic that causes them:
 *
 *  - `SpecWatcher` caches which services the active workflows call, so that a
 *    tick with no spec drift issues no query and the Neon compute can suspend.
 *    Any write here can change that set, so the cache is dropped.
 *  - `PeriodicCleanup` sweeps on the back of write traffic instead of waking the
 *    compute on a 24h timer. It rate-limits itself to once a day internally.
 *
 * Hooked once for the whole router rather than at each write site: a new write
 * site added later is covered without anyone remembering to call these.
 */
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidateSpecWatcherCache();
      noteWorkflowWrite();
    }
  });
  next();
});

function formatWorkflow(w: typeof workflows.$inferSelect) {
  return {
    ...w,
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Re-push a workflow's Windmill flow before it is made executable again.
 *
 * `cleanupOrphanedWindmillFlows` deletes the Windmill flow of any deprecated
 * workflow that no active campaign references, so a version that was retired for
 * a while very likely has no flow left. Restoring the row without restoring the
 * flow produces a workflow that is `status='active'`, gets picked, and then 404s
 * inside Windmill on every execute. `syncFlowToWindmill` re-creates at the
 * recorded path when Windmill answers 404, and is a no-op when the flow is
 * present — so this is safe to call unconditionally on the un-retire path.
 *
 * Throws on failure: an un-retire that cannot restore the flow must fail loudly
 * rather than leave a live-but-broken workflow behind.
 */
async function restoreWindmillFlow(workflow: typeof workflows.$inferSelect): Promise<void> {
  const client = getWindmillClient();
  if (!client) return;
  await syncFlowToWindmill(workflow, client);
}

/** Strip version suffix from slug: "cold-outreach-obsidian-v3" → "cold-outreach-obsidian" */
function toWorkflowDynastySlug(slug: string): string {
  return slug.replace(/-v\d+$/, "");
}

/** Strip version suffix from name: "Cold Outreach Obsidian v3" → "Cold Outreach Obsidian" */
function toWorkflowDynastyName(name: string): string {
  return name.replace(/ v\d+$/, "");
}

function generateFlowPath(scope: string, slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${sanitized}`;
}

/** Convert feature slug to display name: "pr-cold-email-outreach" → "PR Cold Email Outreach" */
function featureSlugToName(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Compose slug with version suffix: no -v1 for v1, -v2 for v2+. */
function composeSlug(base: string, version: number): string {
  return version >= 2 ? `${base}-v${version}` : base;
}

/** Compose display name with version suffix: no v1 for v1, v2 for v2+. */
function composeName(base: string, version: number): string {
  return version >= 2 ? `${base} v${version}` : base;
}

// POST /workflows/create — Create a workflow from a natural-language description.
// Behavior:
//   - If an active workflow already exists for (orgId, featureSlug) and the
//     newly-generated DAG signature matches, return 200 with the existing row
//     unchanged (idempotent).
//   - Otherwise, always create a NEW dynasty (creation_type='scratch'). This
//     endpoint never upgrades existing dynasties — use POST /workflows/upgrade
//     for that.
router.post("/workflows/create", requireApiKey, createRateLimit, async (req, res) => {
  try {
    const body = CreateWorkflowFromDescriptionSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const userId = res.locals.userId as string;
    const runId = res.locals.runId as string;
    const dsHeaders = extractDownstreamHeaders(req);

    traceEvent(runId, {
      service: "workflow-service",
      event: "create-start",
      detail: `Creating workflow for featureSlug="${body.featureSlug}" description="${body.description.slice(0, 100)}"`,
      data: { featureSlug: body.featureSlug, hasHints: !!body.hints },
    }, req.headers).catch(() => {});

    const generated = await generateWorkflow(
      { description: body.description, hints: body.hints },
      dsHeaders,
    );

    const dag = generated.dag as DAG;
    const signature = computeDAGSignature(generated.dag);

    // Idempotent match: same (orgId, featureSlug, signature) returns existing row.
    const [existingMatch] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, orgId),
          eq(workflows.featureSlug, body.featureSlug),
          eq(workflows.signature, signature),
          eq(workflows.status, "active"),
        )
      );

    if (existingMatch) {
      traceEvent(runId, {
        service: "workflow-service",
        event: "create-existing-match",
        detail: `Returning existing active workflow="${existingMatch.workflowSlug}" — same signature`,
      }, req.headers).catch(() => {});

      res.json({
        workflow: {
          id: existingMatch.id,
          workflowSlug: existingMatch.workflowSlug,
          workflowName: existingMatch.workflowName,
          workflowDynastySlug: existingMatch.workflowDynastySlug,
          featureSlug: existingMatch.featureSlug,
          tags: (existingMatch.tags as string[]) ?? [],
          signature: existingMatch.signature,
          workflowDynastySignatureName: existingMatch.workflowDynastySignatureName,
          version: existingMatch.version,
          workflowDynastyStatus: existingMatch.workflowDynastyStatus as "active" | "deprecated",
          action: "existing" as const,
        },
        dag: existingMatch.dag,
        generatedDescription: existingMatch.description ?? generated.description,
      });
      return;
    }

    // New dynasty — pick a unique workflow_dynasty_signature_name. Names are
    // burned for life within a feature_slug (any status, any org), so deprecated
    // rows still count. No org filter.
    const existingFeatureRows = await db
      .select({ workflowDynastySignatureName: workflows.workflowDynastySignatureName })
      .from(workflows)
      .where(eq(workflows.featureSlug, body.featureSlug));
    const existingWorkflowDynastySignatureNamesForFeature = new Set(
      existingFeatureRows.map((w) => w.workflowDynastySignatureName),
    );

    const workflowDynastySignatureName = pickWorkflowDynastySignatureName(
      signature,
      existingWorkflowDynastySignatureNamesForFeature,
    );

    const featureName = featureSlugToName(body.featureSlug);
    const workflowDynastySlug = `${body.featureSlug}-${workflowDynastySignatureName}`;
    const workflowDynastyName = `${featureName} ${workflowDynastySignatureName.charAt(0).toUpperCase() + workflowDynastySignatureName.slice(1)}`;
    const workflowSlug = workflowDynastySlug; // v1 — no version suffix
    const workflowName = workflowDynastyName;

    const openFlow = dagToOpenFlow(dag, workflowSlug);
    const flowPath = generateFlowPath(orgId, workflowSlug);
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: workflowSlug,
          description: generated.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] create: failed to create Windmill flow:", err);
      }
    }

    const [created] = await db
      .insert(workflows)
      .values({
        orgId,
        workflowSlug,
        workflowName,
        workflowDynastySlug,
        workflowDynastyName,
        description: generated.description,
        featureSlug: body.featureSlug,
        category: generated.category,
        channel: generated.channel,
        audienceType: generated.audienceType,
        signature,
        workflowDynastySignatureName,
        version: 1,
        dag: generated.dag,
        windmillFlowPath: flowPath,
        creationType: "scratch",
        createdFromWorkflow: null,
        createdByUserId: userId,
        createdByRunId: runId,
      })
      .returning();

    traceEvent(runId, {
      service: "workflow-service",
      event: "create-complete",
      detail: `Created workflow="${created.workflowSlug}" creationType=scratch signature=${signature.slice(0, 12)}`,
      data: { workflowSlug: created.workflowSlug, signature: signature.slice(0, 12) },
    }, req.headers).catch(() => {});

    res.status(201).json({
      workflow: {
        id: created.id,
        workflowSlug: created.workflowSlug,
        workflowName: created.workflowName,
        workflowDynastySlug: created.workflowDynastySlug,
        featureSlug: created.featureSlug,
        tags: (created.tags as string[]) ?? [],
        signature: created.signature,
        workflowDynastySignatureName: created.workflowDynastySignatureName,
        version: created.version,
        workflowDynastyStatus: created.workflowDynastyStatus as "active" | "deprecated",
        action: "created" as const,
      },
      dag: generated.dag,
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
    console.error("[workflow-service] CREATE error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
      stage: classifyWorkflowError(err),
    });
  }
});

// POST /workflows/upgrade — Apply a new DAG to an existing active workflow,
// either in-place (signature unchanged) or as a new version in the same dynasty
// (signature changed). The new DAG comes from one of two sources:
//   - body.dag (client-supplied) — surgical edits, skips the LLM
//   - body.description + LLM regeneration — caller asks the LLM to redesign
// Exactly one source must be provided; the Zod refine enforces it.
router.post("/workflows/upgrade", requireApiKey, createRateLimit, async (req, res) => {
  try {
    const body = UpgradeWorkflowFromDescriptionSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const userId = res.locals.userId as string;
    const runId = res.locals.runId as string;
    const dsHeaders = extractDownstreamHeaders(req);

    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.workflowDynastySlug, body.workflowDynastySlug),
          eq(workflows.status, "active"),
        )
      );

    if (!existing) {
      res.status(404).json({ error: `Active workflow not found for dynasty "${body.workflowDynastySlug}"` });
      return;
    }

    traceEvent(runId, {
      service: "workflow-service",
      event: "upgrade-start",
      detail: `Upgrading workflow="${existing.workflowSlug}" featureSlug="${existing.featureSlug}" source=${body.dag ? "client-dag" : "llm"}`,
      data: { workflowSlug: existing.workflowSlug, featureSlug: existing.featureSlug, source: body.dag ? "client-dag" : "llm" },
    }, req.headers).catch(() => {});

    let dag: DAG;
    let resolvedDescription: string;
    let resolvedCategory: typeof existing.category;
    let resolvedChannel: typeof existing.channel;
    let resolvedAudienceType: typeof existing.audienceType;

    if (body.dag) {
      const rejection = await validateClientDag(body.dag as DAG, dsHeaders);
      if (rejection) {
        res.status(400).json(rejection);
        return;
      }
      dag = body.dag as DAG;
      resolvedDescription = body.description ?? existing.description ?? "";
      // category/channel/audienceType are LLM-inferred fields; with a client-supplied DAG
      // there is nothing to infer from, so inherit the existing dynasty's values.
      resolvedCategory = existing.category;
      resolvedChannel = existing.channel;
      resolvedAudienceType = existing.audienceType;
    } else {
      const generated = await generateWorkflow(
        { description: body.description!, hints: body.hints },
        dsHeaders,
      );
      dag = generated.dag as DAG;
      resolvedDescription = generated.description;
      resolvedCategory = generated.category;
      resolvedChannel = generated.channel;
      resolvedAudienceType = generated.audienceType;
    }

    const newSignature = computeDAGSignature(dag);

    // Same signature → in-place update.
    if (newSignature === existing.signature) {
      const openFlow = dagToOpenFlow(dag, existing.workflowSlug);
      const client = getWindmillClient();
      if (client && existing.windmillFlowPath) {
        try {
          await client.updateFlow(existing.windmillFlowPath, {
            summary: existing.workflowSlug,
            description: resolvedDescription,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflow-service] upgrade: failed to update Windmill flow:", err);
        }
      }

      const [updated] = await db
        .update(workflows)
        .set({
          description: resolvedDescription,
          category: resolvedCategory,
          channel: resolvedChannel,
          audienceType: resolvedAudienceType,
          dag,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existing.id))
        .returning();

      res.json({
        workflow: {
          id: updated.id,
          workflowSlug: updated.workflowSlug,
          workflowName: updated.workflowName,
          workflowDynastySlug: updated.workflowDynastySlug,
          featureSlug: updated.featureSlug,
          tags: (updated.tags as string[]) ?? [],
          signature: updated.signature,
          workflowDynastySignatureName: updated.workflowDynastySignatureName,
          version: updated.version,
          workflowDynastyStatus: updated.workflowDynastyStatus as "active" | "deprecated",
          action: "updated" as const,
        },
        dag,
        generatedDescription: resolvedDescription,
      });
      return;
    }

    // Conflict guard: a different active workflow in the same feature_slug may
    // already hold this signature (partial unique index idx_workflows_active_sig
    // = (feature_slug, signature) WHERE status='active'). Inserting would violate
    // the constraint and leak a raw Postgres 500. Detect it first and return a
    // clean 409 so the caller knows it can use the existing workflow instead.
    // Mirrors the fork path (PUT /workflows/{id}). Runs BEFORE creating the
    // Windmill flow to avoid leaving an orphan flow behind on conflict.
    const [conflicting] = await db
      .select({
        id: workflows.id,
        workflowSlug: workflows.workflowSlug,
        workflowName: workflows.workflowName,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.featureSlug, existing.featureSlug),
          eq(workflows.signature, newSignature),
          eq(workflows.status, "active"),
        )
      );

    if (conflicting) {
      res.status(409).json({
        error: "A workflow with this DAG signature already exists",
        existingWorkflowId: conflicting.id,
        existingWorkflowSlug: conflicting.workflowSlug,
        existingWorkflowName: conflicting.workflowName,
      });
      return;
    }

    // New signature → upgrade in same dynasty: bump version, deprecate predecessor.
    // The dynasty signature name is immutable per dynasty — reuse the existing one.
    const newVersion = existing.version + 1;
    const newSlug = composeSlug(existing.workflowDynastySlug, newVersion);
    const newName = composeName(existing.workflowDynastyName, newVersion);

    const openFlow = dagToOpenFlow(dag, newSlug);
    const flowPath = generateFlowPath(orgId, newSlug);
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: newSlug,
          description: resolvedDescription,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] upgrade: failed to create Windmill flow:", err);
      }
    }

    // Atomic: deprecate predecessor (status='deprecated') BEFORE inserting the new
    // active row. The partial unique index idx_workflows_active_signame
    // (feature_slug, signature_name) WHERE status='active' would otherwise reject
    // the insert because the predecessor still occupies the (feature_slug, signame)
    // slot. Wrapping in a transaction guarantees both rows commit together.
    let created: typeof workflows.$inferSelect;
    await db.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({ status: "deprecated", updatedAt: new Date() })
        .where(eq(workflows.id, existing.id));

      const [row] = await tx
        .insert(workflows)
        .values({
          orgId,
          createdForBrandId: existing.createdForBrandId,
          humanId: existing.humanId,
          workflowSlug: newSlug,
          workflowName: newName,
          workflowDynastySlug: existing.workflowDynastySlug,
          workflowDynastyName: existing.workflowDynastyName,
          description: resolvedDescription,
          featureSlug: existing.featureSlug,
          category: resolvedCategory,
          channel: resolvedChannel,
          audienceType: resolvedAudienceType,
          tags: (existing.tags as string[]) ?? [],
          signature: newSignature,
          workflowDynastySignatureName: existing.workflowDynastySignatureName,
          version: newVersion,
          dag,
          windmillFlowPath: flowPath,
          // A retired dynasty stays retired across an upgrade. Without this the
          // column defaults to 'active' and upgrading a retired lineage silently
          // un-retires it — the row would execute again while the operator who
          // retired it is told nothing.
          workflowDynastyStatus: existing.workflowDynastyStatus,
          creationType: "upgrade",
          createdFromWorkflow: existing.id,
          createdByUserId: userId,
          createdByRunId: runId,
        })
        .returning();
      created = row;
    });

    // Windmill cleanup of the predecessor flow happens AFTER the DB commit so a
    // rolled-back transaction does not leave Windmill in an inconsistent state.
    // Failures here are logged but never re-thrown — the row is already deprecated.
    if (client && existing.windmillFlowPath) {
      try {
        await client.deleteFlow(existing.windmillFlowPath);
        console.log(
          `[workflow-service] upgrade: deleted Windmill flow "${existing.windmillFlowPath}" for deprecated predecessor "${existing.workflowSlug}"`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("404")) {
          console.warn(
            `[workflow-service] upgrade: failed to delete Windmill flow "${existing.windmillFlowPath}" for "${existing.workflowSlug}":`,
            msg,
          );
        }
      }
    }

    traceEvent(runId, {
      service: "workflow-service",
      event: "upgrade-complete",
      detail: `Upgraded "${existing.workflowSlug}" -> "${created!.workflowSlug}" (v${newVersion}) source=${body.dag ? "client-dag" : "llm"}`,
      data: { from: existing.workflowSlug, to: created!.workflowSlug, version: newVersion, source: body.dag ? "client-dag" : "llm" },
    }, req.headers).catch(() => {});

    res.status(201).json({
      workflow: {
        id: created!.id,
        workflowSlug: created!.workflowSlug,
        workflowName: created!.workflowName,
        workflowDynastySlug: created!.workflowDynastySlug,
        featureSlug: created!.featureSlug,
        tags: (created!.tags as string[]) ?? [],
        signature: created!.signature,
        workflowDynastySignatureName: created!.workflowDynastySignatureName,
        version: created!.version,
        workflowDynastyStatus: created!.workflowDynastyStatus as "active" | "deprecated",
        action: "upgraded" as const,
      },
      dag,
      generatedDescription: resolvedDescription,
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
    console.error("[workflow-service] UPGRADE error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
      stage: classifyWorkflowError(err),
    });
  }
});

// POST /workflows — Create a new workflow
router.post("/workflows", requireApiKey, createRateLimit, async (req, res) => {
  try {
    const body = CreateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const dag = body.dag as DAG;

    // Topology + live endpoint/field validation. A client-supplied DAG gets the
    // same gate the LLM path has always had.
    const rejection = await validateClientDag(dag, extractDownstreamHeaders(req));
    if (rejection) {
      res.status(400).json(rejection);
      return;
    }

    // Compute signature and naming
    const signature = computeDAGSignature(body.dag);

    // Conflict guard: an active workflow in the same feature_slug may already
    // hold this signature (partial unique index idx_workflows_active_sig =
    // (feature_slug, signature) WHERE status='active'). Inserting would violate
    // the constraint and leak a raw Postgres 500. Detect it first and return the
    // same clean 409 the fork path (PUT /workflows/{id}) returns, so the caller
    // learns which workflow already covers this DAG. Scoped like the index
    // itself — no org filter — because the constraint is cross-org.
    // Runs BEFORE the Windmill flow is created so a conflict leaves no orphan.
    const [conflicting] = await db
      .select({
        id: workflows.id,
        workflowSlug: workflows.workflowSlug,
        workflowName: workflows.workflowName,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.featureSlug, body.featureSlug),
          eq(workflows.signature, signature),
          eq(workflows.status, "active"),
        )
      );

    if (conflicting) {
      res.status(409).json({
        error: "A workflow with this DAG signature already exists",
        existingWorkflowId: conflicting.id,
        existingWorkflowSlug: conflicting.workflowSlug,
        existingWorkflowName: conflicting.workflowName,
      });
      return;
    }

    const existingFeatureRows = await db
      .select({ workflowDynastySignatureName: workflows.workflowDynastySignatureName })
      .from(workflows)
      .where(eq(workflows.featureSlug, body.featureSlug));
    const existingWorkflowDynastySignatureNamesForFeature = new Set(
      existingFeatureRows.map((w) => w.workflowDynastySignatureName),
    );
    const workflowDynastySignatureName = pickWorkflowDynastySignatureName(
      signature,
      existingWorkflowDynastySignatureNamesForFeature,
    );

    const featureName = featureSlugToName(body.featureSlug);
    const workflowDynastySlug = `${body.featureSlug}-${workflowDynastySignatureName}`;
    const workflowDynastyName = `${featureName} ${workflowDynastySignatureName.charAt(0).toUpperCase() + workflowDynastySignatureName.slice(1)}`;
    const workflowSlug = workflowDynastySlug; // v1 — no version suffix
    const workflowName = workflowDynastyName;

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, workflowSlug);
    const flowPath = generateFlowPath(orgId, workflowSlug);

    // Push to Windmill (if configured)
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: workflowSlug,
          description: body.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] Failed to create flow in Windmill:", err);
      }
    }

    // Store in DB
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId,
        createdForBrandId: body.createdForBrandId,
        featureSlug: body.featureSlug,
        campaignId: body.campaignId,
        subrequestId: body.subrequestId,
        workflowSlug,
        workflowName,
        workflowDynastySlug,
        workflowDynastyName,
        description: body.description,
        category: body.category,
        channel: body.channel,
        audienceType: body.audienceType,
        tags: body.tags ?? [],
        signature,
        workflowDynastySignatureName,
        version: 1,
        dag: body.dag,
        windmillFlowPath: flowPath,
        createdByUserId: res.locals.userId as string,
        createdByRunId: res.locals.runId as string,
      })
      .returning();

    res.status(201).json(formatWorkflow(workflow));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] POST error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// GET /workflows/dynasties — List all dynasties with their versioned workflow slugs
router.get("/workflows/dynasties", requireApiKey, async (req, res) => {
  try {
    const allWorkflows = await db
      .select({
        workflowSlug: workflows.workflowSlug,
        workflowDynastySlug: workflows.workflowDynastySlug,
        workflowDynastyName: workflows.workflowDynastyName,
      })
      .from(workflows);

    const dynastyMap = new Map<string, { workflowDynastyName: string; workflowSlugs: string[] }>();
    for (const w of allWorkflows) {
      const entry = dynastyMap.get(w.workflowDynastySlug);
      if (entry) {
        entry.workflowSlugs.push(w.workflowSlug);
      } else {
        dynastyMap.set(w.workflowDynastySlug, {
          workflowDynastyName: w.workflowDynastyName,
          workflowSlugs: [w.workflowSlug],
        });
      }
    }

    const dynasties = [...dynastyMap.entries()].map(([workflowDynastySlug, { workflowDynastyName, workflowSlugs }]) => ({
      workflowDynastySlug,
      workflowDynastyName,
      workflowSlugs,
    }));

    res.json({ dynasties });
  } catch (err) {
    console.error("[workflow-service] GET dynasties error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// NOTE: GET /workflows/dynasty/slugs moved to src/routes/public-workflows.ts.
// It resolves a global (cross-org) dynasty slug and is called by org-less, api-key-only
// callers (runs-service / email-gateway public analytics), so it must sit BEFORE the
// global requireIdentity gate. Keeping it here shadowed it → 400 "identity headers required".

// GET /workflows/dynasty/stats — Aggregated stats for a dynasty (full upgrade chain)
router.get("/workflows/dynasty/stats", requireApiKey, async (req, res) => {
  try {
    const workflowDynastySlug = req.query.workflowDynastySlug;
    if (!workflowDynastySlug || typeof workflowDynastySlug !== "string") {
      res.status(400).json({ error: "Missing required query parameter: workflowDynastySlug" });
      return;
    }

    const objectiveParam = req.query.objective;
    if (!objectiveParam || typeof objectiveParam !== "string") {
      res.status(400).json({ error: "Missing required query parameter: objective (stats key, e.g. 'emailsReplied')" });
      return;
    }
    const objective = objectiveParam;

    const dsHeaders = extractDownstreamHeaders(req);

    const allDynastyWorkflows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.workflowDynastySlug, workflowDynastySlug));

    if (allDynastyWorkflows.length === 0) {
      res.status(404).json({ error: `No workflows found for workflowDynastySlug: ${workflowDynastySlug}` });
      return;
    }

    const activeWorkflows = allDynastyWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allDynastyWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.json({
        workflowDynastySlug,
        workflowDynastyName: allDynastyWorkflows[0].workflowDynastyName,
        stats: {
          totalCostInUsdCents: 0,
          totalOutcomes: 0,
          costPerOutcome: null,
          completedRuns: 0,
          email: {
            transactional: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, recipients: 0 },
            broadcast: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, recipients: 0 },
          },
        },
      });
      return;
    }

    const { scores } = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, { kind: "auth", downstreamHeaders: dsHeaders });

    const stats = aggregateSectionStats(scores);

    res.json({
      workflowDynastySlug,
      workflowDynastyName: allDynastyWorkflows[0].workflowDynastyName,
      stats,
    });
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "dynasty/stats")) {
      console.error("[workflow-service] GET dynasty/stats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// PUT /workflows/dynasty/:workflowDynastySlug/status — Retire (or un-retire) a
// whole dynasty. Idempotent (re-applying the same status is a no-op success).
//
// 'deprecated' MEANS RETIRED, and retirement has to be true on both axes at once:
//
//  - workflow_dynasty_status is flipped on EVERY version in the lineage. That is
//    the axis the execute routes consult, so a retired dynasty answers 410 even
//    if a later write leaves some version row marked active.
//  - the per-version `status` of every version is flipped to 'deprecated' too.
//    That is the axis every EXISTING consumer already reads — campaign-service
//    provisions off `GET /workflows?status=active`, features-service picks the
//    executable head out of `/public/workflows?status=all` by `status === 'active'`
//    — so without this half, a retired dynasty keeps being ranked and picked and
//    every resulting run is refused. Retirement that only the producer knows about
//    is the bug this route had.
//
// Un-retiring restores exactly one version to active: the highest version number
// in the lineage, which is the terminal row of the upgrade chain (forks branch
// into a NEW dynasty slug, and predecessors are deprecated on upgrade). The
// partial unique index idx_workflows_active_signame therefore cannot be violated
// — every other row of the lineage is left deprecated.
router.put("/workflows/dynasty/:workflowDynastySlug/status", requireApiKey, async (req, res) => {
  try {
    const { workflowDynastySlug } = req.params;
    const body = DynastyStatusUpdateSchema.parse(req.body);

    // Existence check: unknown dynasty slug → 404.
    const lineage = await db
      .select()
      .from(workflows)
      .where(eq(workflows.workflowDynastySlug, workflowDynastySlug));

    if (lineage.length === 0) {
      res.status(404).json({ error: `No workflows found for workflowDynastySlug: ${workflowDynastySlug}` });
      return;
    }

    // The version to restore on un-retire: highest version = upgrade-chain head.
    const head = lineage.reduce((a, b) => (b.version > a.version ? b : a));

    if (body.status === "active" && head.status !== "active") {
      try {
        await restoreWindmillFlow(head);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow-service] Un-retire "${workflowDynastySlug}": Windmill flow restore failed:`, msg);
        res.status(502).json({ error: `Could not restore the Windmill flow for "${head.workflowSlug}": ${msg}` });
        return;
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(workflows)
        .set({
          workflowDynastyStatus: body.status,
          status: "deprecated",
          updatedAt: new Date(),
        })
        .where(eq(workflows.workflowDynastySlug, workflowDynastySlug));

      if (body.status === "active") {
        await tx
          .update(workflows)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(workflows.id, head.id));
      }
    });

    console.log(
      `[workflow-service] Dynasty "${workflowDynastySlug}" set to ${body.status} across ${lineage.length} version(s)` +
      (body.status === "active" ? ` — restored "${head.workflowSlug}" as the active version` : " — no version left executable"),
    );

    res.json({
      workflowDynastySlug,
      status: body.status,
      updatedWorkflows: lineage.length,
      activeWorkflowSlug: body.status === "active" ? head.workflowSlug : null,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT dynasty status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/:id/status — Retire (or un-retire) ONE version.
//
// The per-version `status` column is what the upgrade path and the stale-workflow
// sweeper already write; until now nothing let an operator write it directly, so
// "retire this one workflow" was only reachable with a hand-written UPDATE against
// the database. Retiring the only active version of a dynasty leaves the dynasty
// with no executable version: execute-by-slug then answers 410 rather than falling
// back to an older version, which is the correct refusal.
//
// Re-activating is refused with 409 when another version of the same dynasty is
// already active — at most one version per dynasty may be active, and the partial
// unique index idx_workflows_active_signame enforces the same thing one layer down.
router.put("/workflows/:id/status", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = WorkflowStatusUpdateSchema.parse(req.body);

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (workflow.status === body.status) {
      res.json(formatWorkflow(workflow));
      return;
    }

    if (body.status === "active") {
      const [conflicting] = await db
        .select({ id: workflows.id, workflowSlug: workflows.workflowSlug })
        .from(workflows)
        .where(
          and(
            eq(workflows.workflowDynastySlug, workflow.workflowDynastySlug),
            eq(workflows.status, "active"),
          )
        );

      if (conflicting) {
        res.status(409).json({
          error:
            `Another version of dynasty "${workflow.workflowDynastySlug}" is already active ` +
            `("${conflicting.workflowSlug}"). Retire it first.`,
          existingWorkflowId: conflicting.id,
          existingWorkflowSlug: conflicting.workflowSlug,
        });
        return;
      }

      try {
        await restoreWindmillFlow(workflow);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workflow-service] Un-retire "${workflow.workflowSlug}": Windmill flow restore failed:`, msg);
        res.status(502).json({ error: `Could not restore the Windmill flow for "${workflow.workflowSlug}": ${msg}` });
        return;
      }
    }

    const [updated] = await db
      .update(workflows)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(workflows.id, workflow.id))
      .returning();

    console.log(
      `[workflow-service] Workflow "${workflow.workflowSlug}" (${workflow.id}) set to status=${body.status}`,
    );

    res.json(formatWorkflow(updated));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT workflow status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows — List workflows (defaults to active only; ?status=all for all)
// Each item is enriched with `requiredProviders` so the caller does not need
// to fan out N follow-up requests to /workflows/:id/required-providers.
// Implementation: walk every returned workflow's DAG once, union all unique
// (service, method, path) endpoints, make a SINGLE key-service POST, then
// remap providers back per workflow.
router.get("/workflows", requireApiKey, async (req, res) => {
  try {
    const { orgId, brandId, humanId, campaignId, featureSlug, workflowSlug, workflowDynastySlug, tag, status } = req.query;

    const conditions: ReturnType<typeof eq>[] = [];

    // Defaults to the runnable set. "active" means EXECUTABLE, which requires
    // both axes: an active version of a retired dynasty is not a candidate and
    // must not be listed as one — that is exactly what campaign-service
    // provisions off (it reads this route with status=active and never looks at
    // the emitted status field).
    const statusFilter = resolveStatusFilter(typeof status === "string" ? status : undefined);
    if (statusFilter.kind === "executable") {
      conditions.push(eq(workflows.status, "active"));
      conditions.push(eq(workflows.workflowDynastyStatus, "active"));
    } else if (statusFilter.kind === "retired") {
      conditions.push(
        or(
          eq(workflows.status, "deprecated"),
          eq(workflows.workflowDynastyStatus, "deprecated"),
        )!
      );
    } else if (statusFilter.kind === "versionStatus") {
      conditions.push(eq(workflows.status, statusFilter.value));
    }

    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflows.orgId, orgId));
    }
    if (brandId && typeof brandId === "string") {
      conditions.push(eq(workflows.createdForBrandId, brandId));
    }
    if (humanId && typeof humanId === "string") {
      conditions.push(eq(workflows.humanId, humanId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflows.campaignId, campaignId));
    }
    if (featureSlug && typeof featureSlug === "string") {
      conditions.push(eq(workflows.featureSlug, featureSlug));
    }
    if (workflowSlug && typeof workflowSlug === "string") {
      conditions.push(eq(workflows.workflowSlug, workflowSlug));
    }
    if (workflowDynastySlug && typeof workflowDynastySlug === "string") {
      conditions.push(eq(workflows.workflowDynastySlug, workflowDynastySlug));
    }
    if (tag && typeof tag === "string") {
      conditions.push(sql`${workflows.tags} @> ${JSON.stringify([tag])}::jsonb`);
    }

    const results = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    // Per-workflow endpoint lists + global deduped union
    const endpointsPerWorkflow = results.map((w) =>
      extractHttpEndpoints((w.dag as DAG) ?? { nodes: [], edges: [] }),
    );
    const unionMap = new Map<string, { service: string; method: string; path: string }>();
    for (const list of endpointsPerWorkflow) {
      for (const ep of list) {
        const key = `${ep.service}|${ep.method}|${ep.path}`;
        if (!unionMap.has(key)) unionMap.set(key, ep);
      }
    }

    // Map endpointKey → set of providers (populated by single key-service call)
    const endpointProviders = new Map<string, Set<string>>();

    if (unionMap.size > 0) {
      const dsHeaders = extractDownstreamHeaders(req);
      try {
        const result = await fetchProviderRequirements([...unionMap.values()], dsHeaders);
        for (const r of result.requirements as Array<{
          service?: unknown;
          method?: unknown;
          path?: unknown;
          provider?: unknown;
        }>) {
          if (
            typeof r.service !== "string" ||
            typeof r.method !== "string" ||
            typeof r.path !== "string" ||
            typeof r.provider !== "string"
          ) continue;
          const key = `${r.service}|${r.method}|${r.path}`;
          let set = endpointProviders.get(key);
          if (!set) {
            set = new Set();
            endpointProviders.set(key, set);
          }
          set.add(r.provider);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("key-service error:")) {
          console.error("[workflow-service] GET /workflows: key-service error:", err.message);
          res.status(502).json({ error: err.message });
          return;
        }
        if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
          res.status(502).json({ error: err.message });
          return;
        }
        if (err instanceof TypeError && err.message === "fetch failed") {
          const cause = (err as unknown as { cause?: { code?: string } }).cause;
          const detail = cause?.code ? ` (${cause.code})` : "";
          console.error(`[workflow-service] GET /workflows: key-service unreachable${detail}`, err);
          res.status(502).json({ error: `key-service unreachable${detail}` });
          return;
        }
        throw err;
      }
    }

    const enriched = results.map((w, i) => {
      const providers = new Set<string>();
      for (const ep of endpointsPerWorkflow[i]) {
        const key = `${ep.service}|${ep.method}|${ep.path}`;
        const set = endpointProviders.get(key);
        if (set) {
          for (const p of set) providers.add(p);
        }
      }
      return {
        ...formatWorkflow(w),
        // Locked list contract: `status` reflects the item's DYNASTY status
        // (active/deprecated) so the dashboard renders one flag per dynasty row.
        status: w.workflowDynastyStatus,
        requiredProviders: enrichProvidersWithDomains([...providers].sort()),
      };
    });

    res.json({ workflows: enriched });
  } catch (err) {
    console.error("[workflow-service] GET list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id — Get one workflow
router.get("/workflows/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
    console.error("[workflow-service] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id/required-providers — Compute required BYOK providers for a workflow
router.get("/workflows/:id/required-providers", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const dsHeaders = extractDownstreamHeaders(req);

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

    const result = await fetchProviderRequirements(endpoints, dsHeaders);

    res.json({
      endpoints,
      requirements: result.requirements,
      providers: enrichProvidersWithDomains(result.providers),
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("key-service error:")) {
      console.error("[workflow-service] required-providers: key-service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof TypeError && err.message === "fetch failed") {
      const cause = (err as unknown as { cause?: { code?: string } }).cause;
      const detail = cause?.code ? ` (${cause.code})` : "";
      console.error(`[workflow-service] required-providers: key-service unreachable${detail}`, err);
      res.status(502).json({ error: `key-service unreachable${detail}` });
      return;
    }
    console.error("[workflow-service] required-providers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/:id — Update a workflow (metadata or DAG)
// - No DAG → metadata update in-place
// - DAG with same signature → update in-place
// - DAG with new signature → fork (new dynasty), optionally deprecate source dynasty
router.put("/workflows/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const body = UpdateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;

    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // --- Case 1: No DAG provided — metadata-only in-place update ---
    if (!body.dag) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const [updated] = await db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, req.params.id))
        .returning();

      res.json({ ...formatWorkflow(updated), _action: "updated" as const });
      return;
    }

    // --- DAG provided — validate it ---
    // Covers both branches below: the same-signature in-place update and the
    // fork. Both store the DAG verbatim, so both need the full gate.
    const dag = body.dag as DAG;
    const rejection = await validateClientDag(dag, extractDownstreamHeaders(req));
    if (rejection) {
      res.status(400).json(rejection);
      return;
    }

    const newSignature = computeDAGSignature(body.dag);

    // --- Case 2: Same signature — no structural change, update in-place ---
    if (newSignature === existing.signature) {
      const updates: Record<string, unknown> = { updatedAt: new Date(), dag: body.dag };
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const openFlow = dagToOpenFlow(dag, existing.workflowSlug);
      if (existing.windmillFlowPath) {
        const client = getWindmillClient();
        if (client) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: existing.workflowSlug,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflow-service] Failed to update flow in Windmill:", err);
          }
        }
      }

      const [updated] = await db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, req.params.id))
        .returning();

      res.json({ ...formatWorkflow(updated), _action: "updated" as const });
      return;
    }

    // --- Case 3: Different signature — FORK: create new workflow in new dynasty ---

    // Check for existing active workflow with same signature (conflict)
    const [conflicting] = await db
      .select({
        id: workflows.id,
        workflowSlug: workflows.workflowSlug,
        workflowName: workflows.workflowName,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.featureSlug, existing.featureSlug),
          eq(workflows.signature, newSignature),
          eq(workflows.status, "active"),
        )
      );

    if (conflicting) {
      res.status(409).json({
        error: "A workflow with this DAG signature already exists",
        existingWorkflowId: conflicting.id,
        existingWorkflowSlug: conflicting.workflowSlug,
        existingWorkflowName: conflicting.workflowName,
      });
      return;
    }

    // Generate new workflow_dynasty_signature_name. Names are burned for life
    // within a feature_slug (any status, any org). No org filter, no status filter.
    const existingFeatureRows = await db
      .select({ workflowDynastySignatureName: workflows.workflowDynastySignatureName })
      .from(workflows)
      .where(eq(workflows.featureSlug, existing.featureSlug));
    const existingWorkflowDynastySignatureNamesForFeature = new Set(
      existingFeatureRows.map((w) => w.workflowDynastySignatureName),
    );
    const workflowDynastySignatureName = pickWorkflowDynastySignatureName(
      newSignature,
      existingWorkflowDynastySignatureNamesForFeature,
    );

    const featureName = featureSlugToName(existing.featureSlug);
    const newWorkflowDynastySlug = `${existing.featureSlug}-${workflowDynastySignatureName}`;
    const newWorkflowDynastyName = `${featureName} ${workflowDynastySignatureName.charAt(0).toUpperCase() + workflowDynastySignatureName.slice(1)}`;
    const newWorkflowSlug = newWorkflowDynastySlug; // v1 has no version suffix
    const newWorkflowName = newWorkflowDynastyName;

    const openFlow = dagToOpenFlow(dag, newWorkflowSlug);
    const flowPath = generateFlowPath(orgId, newWorkflowSlug);
    const client = getWindmillClient();

    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: newWorkflowSlug,
          description: body.description ?? existing.description ?? undefined,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          try {
            await client.updateFlow(flowPath, {
              summary: newWorkflowSlug,
              description: body.description ?? existing.description ?? undefined,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (updateErr) {
            console.error("[workflow-service] Failed to update existing forked flow in Windmill:", updateErr);
          }
        } else {
          console.error("[workflow-service] Failed to create forked flow in Windmill:", err);
        }
      }
    }

    let forked;
    try {
      const [row] = await db
        .insert(workflows)
        .values({
          orgId: existing.orgId,
          createdForBrandId: existing.createdForBrandId,
          featureSlug: existing.featureSlug,
          humanId: existing.humanId,
          campaignId: existing.campaignId,
          subrequestId: existing.subrequestId,
          workflowSlug: newWorkflowSlug,
          workflowName: newWorkflowName,
          workflowDynastySlug: newWorkflowDynastySlug,
          workflowDynastyName: newWorkflowDynastyName,
          description: body.description ?? existing.description,
          category: existing.category,
          channel: existing.channel,
          audienceType: existing.audienceType,
          tags: body.tags ?? (existing.tags as string[]) ?? [],
          signature: newSignature,
          workflowDynastySignatureName,
          version: 1,
          dag: body.dag,
          status: "active",
          creationType: "fork",
          createdFromWorkflow: existing.id,
          windmillFlowPath: flowPath,
          createdByUserId: res.locals.userId as string,
          createdByRunId: res.locals.runId as string,
        })
        .returning();
      forked = row;
    } catch (dbErr: unknown) {
      if (dbErr instanceof Error && "code" in dbErr && (dbErr as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "A workflow with this name already exists",
          detail: (dbErr as { detail?: string }).detail,
        });
        return;
      }
      throw dbErr;
    }

    console.log(
      `[workflow-service] fork: "${existing.workflowSlug}" (${existing.id}) -> "${newWorkflowSlug}" (${forked.id}) [source kept active]`,
    );

    res.status(201).json({
      ...formatWorkflow(forked),
      _action: "forked" as const,
      _forkedFromWorkflowName: existing.workflowName,
      _forkedFromId: existing.id,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workflows/:id — Hard delete
router.delete("/workflows/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
            "[workflow-service] Failed to delete flow in Windmill:",
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
    console.error("[workflow-service] DELETE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /workflows/:id/validate — Validate DAG structure + template contracts
router.post("/workflows/:id/validate", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
  try {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const dag = workflow.dag as DAG;
    const validation = validateDAG(dag);

    // Endpoint validation: every http.call must match a real path/method in the
    // current OpenAPI spec served by the API Registry. Field-level checks
    // (required body fields, unknown body fields, output $ref paths) are
    // included. Fails loud if the registry is unreachable — a silent skip
    // would let drifted workflows look healthy.
    const httpEndpoints = extractHttpEndpoints(dag);
    const serviceNames = [...new Set(httpEndpoints.map((e) => e.service))];
    const specs = serviceNames.length > 0
      ? await fetchSpecsForServices(serviceNames, extractDownstreamHeaders(req))
      : new Map<string, Record<string, unknown>>();
    const endpointResult = validateWorkflowEndpoints(dag, specs);

    // Template contract validation (best-effort — doesn't block if content-gen is unreachable)
    let templateContract: { valid: boolean; templateRefs: TemplateRef[]; issues: TemplateContractIssue[] } | undefined;
    try {
      const templateRefs = extractTemplateRefs(dag);
      if (templateRefs.length > 0) {
        const types = templateRefs.map((r) => r.templateType);
        const templates = await fetchPromptTemplates(types, extractDownstreamHeaders(req));
        templateContract = validateTemplateContracts(dag, templates);
      }
    } catch (err) {
      console.warn("[workflow-service] Template contract check skipped:", err instanceof Error ? err.message : err);
    }

    const result: Record<string, unknown> = {
      ...validation,
      valid: validation.valid && endpointResult.valid,
      invalidEndpoints: endpointResult.invalidEndpoints,
      fieldIssues: endpointResult.fieldIssues,
    };
    if (templateContract) {
      result.valid = (result.valid as boolean) && templateContract.valid;
      result.templateContract = templateContract;
    }

    res.json(result);
  } catch (err) {
    console.error("[workflow-service] VALIDATE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
