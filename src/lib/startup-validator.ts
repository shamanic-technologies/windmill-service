import { eq, inArray, sql } from "drizzle-orm";
import { workflows, workflowRuns, type Workflow } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { DAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import {
  fetchServiceList,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import { dagToOpenFlow } from "./dag-to-openflow.js";
import type { WindmillClient } from "./windmill-client.js";
import { deprecateStaleWorkflows } from "./stale-workflow-deprecator.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";
import { cleanupOrphanedWindmillFlows } from "./windmill-flow-cleanup.js";

type Database = typeof DbInstance;

interface StartupValidatorDeps {
  db: Database;
  windmillClient: WindmillClient | null;
}

/**
 * Ping API Registry to verify it's reachable. Throws on failure.
 */
export async function checkApiRegistryHealth(): Promise<void> {
  await fetchServiceList();
}

/**
 * Validate all active workflows against the API Registry.
 * Attempts LLM-powered upgrade for broken workflows.
 * Throws if any workflow has broken endpoints that cannot be fixed — the service
 * should crash at startup rather than silently running with broken workflows.
 */
export async function validateAndUpgradeWorkflows(
  deps: StartupValidatorDeps,
): Promise<void> {
  const { db: database, windmillClient } = deps;

  // 0a. Verify API Registry is reachable before any validation/upgrade.
  // If unreachable, we can't trust spec results — a missing spec might just be infra flaking,
  // not a genuinely removed service. Skip the entire cycle to avoid wasting LLM costs.
  try {
    await fetchServiceList();
  } catch (err) {
    console.error(
      "[workflow-service] API Registry unreachable — skipping upgrade cycle. No workflows will be validated or upgraded.",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  // 0b. Deprecate stale workflows BEFORE validation — avoids paying for LLM upgrades on unused workflows
  try {
    const result = await deprecateStaleWorkflows(database);
    if (result.deprecatedCount > 0) {
      console.log(
        `[workflow-service] Stale deprecation: ${result.deprecatedCount} deprecated, ${result.keptByCampaign} kept by active campaign`,
      );
    }
    if (result.skippedNoCampaignService) {
      console.warn("[workflow-service] Stale deprecation skipped — campaign-service unreachable");
    }
  } catch (err) {
    console.warn(
      "[workflow-service] Stale workflow deprecation failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
  }

  // 1. Fetch all active workflows
  const activeWorkflows = await database
    .select()
    .from(workflows)
    .where(eq(workflows.status, "active"));

  if (activeWorkflows.length === 0) {
    console.log("[workflow-service] No active workflows to validate");
    return;
  }

  // Sort by most recent usage — workflows used recently get upgraded first,
  // so the ones that actually matter in prod are fixed before dormant ones.
  const lastRunRows = await database
    .select({
      workflowId: workflowRuns.workflowId,
      lastRun: sql<string>`max(${workflowRuns.createdAt})`.as("last_run"),
    })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, activeWorkflows.map((w) => w.id)))
    .groupBy(workflowRuns.workflowId);

  const lastRunByWorkflowId = new Map(
    lastRunRows.map((r) => [r.workflowId, new Date(r.lastRun).getTime()]),
  );

  activeWorkflows.sort((a, b) => {
    const aTime = lastRunByWorkflowId.get(a.id) ?? 0;
    const bTime = lastRunByWorkflowId.get(b.id) ?? 0;
    return bTime - aTime; // Most recent first
  });

  // 2. Collect unique service names across all workflows
  const allServiceNames = new Set<string>();
  for (const wf of activeWorkflows) {
    const endpoints = extractHttpEndpoints(wf.dag as DAG);
    for (const ep of endpoints) {
      allServiceNames.add(ep.service);
    }
  }

  // 3. Fetch OpenAPI specs for all services (no identity needed for read-only endpoints)
  const specs = await fetchSpecsForServices([...allServiceNames]);

  // 4. Validate each workflow
  let validCount = 0;
  let upgradedCount = 0;
  let failedCount = 0;

  for (const wf of activeWorkflows) {
    const dag = wf.dag as DAG;
    const result = validateWorkflowEndpoints(dag, specs);

    // Log all field issues (warnings + errors) for visibility
    if (result.fieldIssues.length > 0) {
      console.warn(
        `[workflow-service] Workflow "${wf.workflowSlug}" (${wf.id}) has ${result.fieldIssues.length} field issue(s):`,
        result.fieldIssues.map((f) => f.reason).join("; "),
      );
    }

    // Only attempt upgrade for actual errors — warnings alone don't block startup
    const hasFieldErrors = result.fieldIssues.some((i) => i.severity === "error");
    const needsUpgrade = !result.valid || hasFieldErrors;

    if (!needsUpgrade) {
      validCount++;
      continue;
    }

    if (result.invalidEndpoints.length > 0) {
      console.warn(
        `[workflow-service] Workflow "${wf.workflowSlug}" (${wf.id}) has ${result.invalidEndpoints.length} broken endpoint(s):`,
        result.invalidEndpoints.map((ep) => `${ep.method} ${ep.service}${ep.path}`).join(", "),
      );
    }

    // LLM auto-upgrade DISABLED — was burning Gemini credits on every startup/spec change.
    // Keeping workflows active with broken endpoints rather than paying for LLM fixes.
    // To re-enable: restore the attemptUpgrade() call here.
    failedCount++;
    console.warn(
      `[workflow-service] Workflow "${wf.workflowSlug}" has broken endpoints — LLM upgrade disabled, keeping active`,
    );
  }

  console.log(
    `[workflow-service] Validated ${activeWorkflows.length} workflows: ${validCount} valid, ${failedCount} broken (LLM upgrade disabled)`,
  );

  // 5. Sync all active workflows to Windmill — ensures DB DAG changes
  //    (e.g. new inputMapping fields) are reflected in Windmill flows.
  //    Re-fetch active workflows since upgrades may have changed them.
  if (windmillClient) {
    const currentActive = await database
      .select()
      .from(workflows)
      .where(eq(workflows.status, "active"));

    let synced = 0;
    for (const wf of currentActive) {
      try {
        await syncFlowToWindmill(wf, windmillClient);
        synced++;
      } catch (err) {
        console.warn(
          `[workflow-service] Failed to sync flow for "${wf.workflowSlug}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.log(`[workflow-service] Synced ${synced}/${currentActive.length} flows to Windmill`);

    // 6. Garbage-collect orphan Windmill flows: deprecated workflows whose flow
    //    is still in Windmill and whose slug is not referenced by an active
    //    campaign. Skipped if campaign-service is unreachable so we don't
    //    delete flows we can't prove are unused.
    try {
      const activeCampaignSlugs = await fetchActiveWorkflowSlugs();
      const result = await cleanupOrphanedWindmillFlows(database, windmillClient, activeCampaignSlugs);
      console.log(
        `[workflow-service] Windmill cleanup: deleted=${result.deleted} kept=${result.kept} failed=${result.failed}`,
      );
    } catch (err) {
      console.warn(
        "[workflow-service] Windmill cleanup skipped — could not fetch active campaigns:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function syncFlowToWindmill(
  wf: Workflow,
  windmillClient: WindmillClient,
): Promise<void> {
  if (!wf.windmillFlowPath) {
    return; // No flow deployed — nothing to sync
  }

  const dag = wf.dag as DAG;
  const openFlow = dagToOpenFlow(dag, wf.workflowSlug);
  const body = {
    summary: wf.workflowSlug,
    description: wf.description ?? "",
    value: openFlow.value,
    schema: openFlow.schema,
  };

  try {
    await windmillClient.updateFlow(wf.windmillFlowPath, body);
  } catch (err) {
    // The row says a flow lives at this path and Windmill disagrees. Update
    // alone can never recover from that: the workflow stays active, every
    // execute 404s on the missing flow, and the next boot fails the same way.
    // Recreating at the recorded path is what the row already asserts should
    // exist, and is a no-op wherever the flow is present.
    if (!(err instanceof Error) || !err.message.includes("404")) throw err;

    console.warn(
      `[workflow-service] Flow missing in Windmill for "${wf.workflowSlug}" at ${wf.windmillFlowPath} — recreating`,
    );
    await windmillClient.createFlow({ path: wf.windmillFlowPath, ...body });
  }
}

