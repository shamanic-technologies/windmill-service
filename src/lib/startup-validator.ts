import { eq } from "drizzle-orm";
import { workflows, type Workflow } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { DAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import {
  fetchServiceList,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import { validateWorkflowEndpoints, type FieldValidationIssue } from "./validate-workflow-endpoints.js";
import { upgradeWorkflow } from "./workflow-upgrader.js";
import { dagToOpenFlow } from "./dag-to-openflow.js";
import { computeDAGSignature } from "./dag-signature.js";
import { pickSignatureName } from "./signature-words.js";
import type { WindmillClient } from "./windmill-client.js";
import { fetchPlatformAnthropicKey } from "./key-service-client.js";
import { createPlatformRun, closePlatformRun } from "./runs-client.js";

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

  // 1. Fetch all active workflows
  const activeWorkflows = await database
    .select()
    .from(workflows)
    .where(eq(workflows.status, "active"));

  if (activeWorkflows.length === 0) {
    console.log("[workflow-service] No active workflows to validate");
    return;
  }

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

    if (result.fieldIssues.length > 0) {
      const hasErrors = result.fieldIssues.some((f) => f.severity === "error");
      // Use console.log for warning-only issues (avoids red/orange in Railway logs)
      const log = hasErrors ? console.warn : console.log;
      log(
        `[workflow-service] Workflow "${wf.name}" (${wf.id}) has ${result.fieldIssues.length} field issue(s):`,
        result.fieldIssues.map((f) => `${f.severity}: ${f.reason}`).join("; "),
      );
    }

    if (result.valid) {
      validCount++;
      continue;
    }

    if (result.invalidEndpoints.length > 0) {
      console.warn(
        `[workflow-service] Workflow "${wf.name}" (${wf.id}) has ${result.invalidEndpoints.length} broken endpoint(s):`,
        result.invalidEndpoints.map((ep) => `${ep.method} ${ep.service}${ep.path}`).join(", "),
      );
    }

    const fieldErrors = result.fieldIssues.filter((f) => f.severity === "error");
    if (fieldErrors.length > 0 && result.invalidEndpoints.length === 0) {
      console.warn(
        `[workflow-service] Workflow "${wf.name}" (${wf.id}) has ${fieldErrors.length} field error(s) — attempting upgrade`,
      );
    }

    // Attempt upgrade
    try {
      const upgraded = await attemptUpgrade(
        wf,
        dag,
        result.invalidEndpoints,
        result.fieldIssues.filter((f) => f.severity === "error"),
        database,
        windmillClient,
      );

      if (upgraded) {
        upgradedCount++;
        console.log(
          `[workflow-service] Workflow "${wf.name}" upgraded successfully -> new ID: ${upgraded}`,
        );
      } else {
        // Upgrade skipped (no Anthropic key available) — keep workflow active
        failedCount++;
        console.warn(
          `[workflow-service] Workflow "${wf.name}" has broken endpoints but upgrade skipped (platform key not available) — keeping active`,
        );
      }
    } catch (err) {
      // Upgrade failed — keep workflow active rather than breaking all campaigns
      failedCount++;
      console.error(
        `[workflow-service] Workflow "${wf.name}" upgrade failed — keeping active:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Send admin notification
    try {
      await sendAdminNotification(wf, result.invalidEndpoints, upgradedCount > failedCount);
    } catch {
      // Non-blocking — log and continue
      console.warn(`[workflow-service] Failed to send admin notification for "${wf.name}"`);
    }
  }

  console.log(
    `[workflow-service] Validated ${activeWorkflows.length} workflows: ${validCount} valid, ${upgradedCount} upgraded, ${failedCount} failed`,
  );

  if (failedCount > 0) {
    throw new Error(
      `[workflow-service] ${failedCount} workflow(s) have broken endpoints that could not be auto-upgraded. Fix the workflows or provide the platform Anthropic key, then restart.`,
    );
  }
}

async function attemptUpgrade(
  wf: Workflow,
  dag: DAG,
  invalidEndpoints: Array<{ service: string; method: string; path: string; reason: string }>,
  fieldErrors: FieldValidationIssue[],
  database: Database,
  windmillClient: WindmillClient | null,
): Promise<string | null> {
  // Resolve Anthropic API key via key-service platform endpoint
  let anthropicApiKey: string;
  try {
    const keyResult = await fetchPlatformAnthropicKey();
    anthropicApiKey = keyResult.key;
  } catch (err) {
    console.warn(
      "[workflow-service] Platform Anthropic key not available — upgrade skipped:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  // Track this upgrade as a platform-level run
  let platformRunId: string | undefined;
  try {
    const run = await createPlatformRun({
      serviceName: "workflow",
      taskName: "startup-upgrade",
      workflowName: wf.name,
    });
    platformRunId = run.runId;
  } catch (err) {
    console.warn(
      "[workflow-service] Failed to create platform run — continuing without tracking:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const result = await upgradeWorkflow(
      dag,
      invalidEndpoints,
      fieldErrors,
      anthropicApiKey,
      undefined,
      {
        category: wf.category,
        channel: wf.channel,
        audienceType: wf.audienceType,
        description: wf.description ?? "",
      },
    );

    // Compute new signature
    const newSignature = computeDAGSignature(result.dag);

    // Get used signature names to avoid collisions
    const existingWorkflows = await database
      .select({ signatureName: workflows.signatureName })
      .from(workflows);
    const usedNames = new Set<string>(existingWorkflows.map((w) => w.signatureName));

    const newSignatureName = pickSignatureName(newSignature, usedNames);

    // Reuse the old workflow's name so clients calling by-name are not disrupted
    const stableName = wf.name;

    // Deploy to Windmill
    const openFlow = dagToOpenFlow(result.dag, stableName);
    const flowPath = `f/workflows/${wf.orgId}/${stableName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    let windmillFlowPath: string | null = null;

    if (windmillClient) {
      // Try updateFlow first (flow usually exists from previous startup).
      // Only fall back to createFlow if the flow doesn't exist yet.
      // This avoids Windmill logging noisy 400 "already exists" errors.
      try {
        await windmillClient.updateFlow(flowPath, {
          summary: stableName,
          description: result.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
        windmillFlowPath = flowPath;
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        if (msg.includes("not found") || msg.includes("404")) {
          try {
            await windmillClient.createFlow({
              path: flowPath,
              summary: stableName,
              description: result.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
            windmillFlowPath = flowPath;
          } catch (createErr) {
            console.error("[workflow-service] Failed to create flow in Windmill:", createErr);
          }
        } else {
          console.error("[workflow-service] Failed to update flow in Windmill:", updateErr);
        }
      }
    }

    // Deprecate old workflow FIRST (frees the unique name index for the replacement)
    await deprecateWorkflow(database, wf.id, null);

    // Insert new active workflow with the same name
    const [created] = await database
      .insert(workflows)
      .values({
        orgId: wf.orgId,
        brandId: wf.brandId,
        humanId: wf.humanId,
        campaignId: wf.campaignId,
        subrequestId: wf.subrequestId,
        styleName: wf.styleName,
        name: stableName,
        displayName: wf.displayName ?? stableName,
        description: result.description,
        category: result.category,
        channel: result.channel,
        audienceType: result.audienceType,
        signature: newSignature,
        signatureName: newSignatureName,
        dag: result.dag,
        tags: wf.tags as string[],
        status: "active",
        createdByUserId: "workflow-service",
        createdByRunId: platformRunId ?? "startup-upgrade",
        windmillFlowPath,
        windmillWorkspace: wf.windmillWorkspace,
      })
      .returning();

    // Update the deprecated workflow's upgradedTo pointer
    await database
      .update(workflows)
      .set({ upgradedTo: created.id })
      .where(eq(workflows.id, wf.id));

    // Close platform run as completed
    if (platformRunId) {
      try {
        await closePlatformRun(platformRunId, "completed");
      } catch {
        // Non-blocking
      }
    }

    return created.id;
  } catch (err) {
    // Close platform run as failed
    if (platformRunId) {
      try {
        await closePlatformRun(platformRunId, "failed");
      } catch {
        // Non-blocking
      }
    }
    throw err;
  }
}

async function deprecateWorkflow(
  database: Database,
  workflowId: string,
  upgradedTo: string | null,
): Promise<void> {
  await database
    .update(workflows)
    .set({
      status: "deprecated",
      upgradedTo,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflowId));
}

async function sendAdminNotification(
  wf: Workflow,
  invalidEndpoints: Array<{ service: string; method: string; path: string; reason: string }>,
  upgraded: boolean,
): Promise<void> {
  const emailServiceUrl = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const emailApiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;

  if (!emailServiceUrl || !emailApiKey || !adminEmail) {
    return;
  }

  const endpointList = invalidEndpoints
    .map((ep) => `${ep.method} ${ep.service}${ep.path} — ${ep.reason}`)
    .join("\n");

  const subject = upgraded
    ? `[Workflow Service] Workflow "${wf.name}" auto-upgraded`
    : `[Workflow Service] Workflow "${wf.name}" deprecated — manual intervention required`;

  const body = `Workflow: ${wf.name} (${wf.id})
Org ID: ${wf.orgId}
Status: ${upgraded ? "Auto-upgraded successfully" : "Deprecated — upgrade failed"}

Invalid endpoints:
${endpointList}

${upgraded ? "A new version has been created with corrected endpoints." : "The workflow has been deprecated but could not be automatically fixed. Please review and fix manually."}

Warning: If an endpoint is actually valid but missing from the OpenAPI spec, update the spec in the source service and redeploy.`;

  try {
    await fetch(`${emailServiceUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": emailApiKey,
        "x-service-name": "workflow-service",
      },
      body: JSON.stringify({
        to: adminEmail,
        subject,
        bodyText: body,
      }),
    });
  } catch {
    // Non-blocking
  }
}
