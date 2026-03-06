import { eq } from "drizzle-orm";
import { workflows, type Workflow } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { DAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import {
  fetchServiceList,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import { upgradeWorkflow } from "./workflow-upgrader.js";
import { dagToOpenFlow } from "./dag-to-openflow.js";
import { computeDAGSignature } from "./dag-signature.js";
import { pickSignatureName } from "./signature-words.js";
import type { WindmillClient } from "./windmill-client.js";
import type { IdentityHeaders } from "./key-service-client.js";

type Database = typeof DbInstance;

interface StartupValidatorDeps {
  db: Database;
  windmillClient: WindmillClient | null;
}

/**
 * Temporary identity for API Registry calls.
 * TODO: Remove once API Registry drops identity requirements on read-only spec endpoints.
 */
const PLATFORM_IDENTITY: IdentityHeaders = {
  orgId: "workflow-service",
  userId: "workflow-service",
  runId: "startup-validation",
};

/**
 * Ping API Registry to verify it's reachable. Throws on failure.
 */
export async function checkApiRegistryHealth(): Promise<void> {
  await fetchServiceList(PLATFORM_IDENTITY);
}

/**
 * Validate all active workflows against the API Registry.
 * Deprecates workflows with broken endpoints and attempts LLM-powered upgrade.
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
    console.log("[startup] No active workflows to validate");
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

  // 3. Fetch OpenAPI specs for all services
  const specs = await fetchSpecsForServices(
    [...allServiceNames],
    PLATFORM_IDENTITY,
  );

  // 4. Validate each workflow
  let validCount = 0;
  let upgradedCount = 0;
  let failedCount = 0;

  for (const wf of activeWorkflows) {
    const dag = wf.dag as DAG;
    const result = validateWorkflowEndpoints(dag, specs);

    if (result.valid) {
      validCount++;
      continue;
    }

    console.warn(
      `[startup] Workflow "${wf.name}" (${wf.id}) has ${result.invalidEndpoints.length} broken endpoint(s):`,
      result.invalidEndpoints.map((ep) => `${ep.method} ${ep.service}${ep.path}`).join(", "),
    );

    // Attempt upgrade
    try {
      const upgraded = await attemptUpgrade(
        wf,
        dag,
        result.invalidEndpoints,
        database,
        windmillClient,
      );

      if (upgraded) {
        upgradedCount++;
        console.log(
          `[startup] Workflow "${wf.name}" upgraded successfully -> new ID: ${upgraded}`,
        );
      } else {
        // Upgrade skipped (no Anthropic key available)
        failedCount++;
        await deprecateWorkflow(database, wf.id, null);
        console.warn(
          `[startup] Workflow "${wf.name}" deprecated (upgrade skipped: platform key not available)`,
        );
      }
    } catch (err) {
      failedCount++;
      await deprecateWorkflow(database, wf.id, null);
      console.error(
        `[startup] Workflow "${wf.name}" upgrade failed, deprecated:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Send admin notification
    try {
      await sendAdminNotification(wf, result.invalidEndpoints, upgradedCount > failedCount);
    } catch {
      // Non-blocking — log and continue
      console.warn(`[startup] Failed to send admin notification for "${wf.name}"`);
    }
  }

  console.log(
    `[startup] Validated ${activeWorkflows.length} workflows: ${validCount} valid, ${upgradedCount} upgraded, ${failedCount} failed`,
  );
}

async function attemptUpgrade(
  wf: Workflow,
  dag: DAG,
  invalidEndpoints: Array<{ service: string; method: string; path: string; reason: string }>,
  database: Database,
  windmillClient: WindmillClient | null,
): Promise<string | null> {
  // Resolve Anthropic API key — blocked until key-service supports platform-level key resolution
  // TODO: Replace with platform key resolution once key-service adds GET /keys/platform/anthropic/decrypt
  const anthropicApiKey = process.env.PLATFORM_ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.warn("[startup] PLATFORM_ANTHROPIC_API_KEY not set — upgrade skipped");
    return null;
  }

  const result = await upgradeWorkflow(
    dag,
    invalidEndpoints,
    anthropicApiKey,
    PLATFORM_IDENTITY,
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
  const newName = `${result.category}-${result.channel}-${result.audienceType}-${newSignatureName}`;

  // Deploy to Windmill
  const openFlow = dagToOpenFlow(result.dag, newName);
  const flowPath = `f/workflows/${wf.orgId}/${newName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  let windmillFlowPath: string | null = null;

  if (windmillClient) {
    try {
      await windmillClient.createFlow({
        path: flowPath,
        summary: newName,
        description: result.description,
        value: openFlow.value,
        schema: openFlow.schema,
      });
      windmillFlowPath = flowPath;
    } catch (err) {
      console.error("[startup] Failed to create upgraded flow in Windmill:", err);
    }
  }

  // Insert new active workflow
  const [created] = await database
    .insert(workflows)
    .values({
      orgId: wf.orgId,
      brandId: wf.brandId,
      humanId: wf.humanId,
      campaignId: wf.campaignId,
      subrequestId: wf.subrequestId,
      styleName: wf.styleName,
      name: newName,
      displayName: wf.displayName,
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
      createdByRunId: "startup-upgrade",
      windmillFlowPath,
      windmillWorkspace: wf.windmillWorkspace,
    })
    .returning();

  // Deprecate old workflow
  await deprecateWorkflow(database, wf.id, created.id);

  return created.id;
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
        "x-org-id": wf.orgId,
        "x-user-id": "workflow-service",
        "x-run-id": "startup-upgrade",
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
