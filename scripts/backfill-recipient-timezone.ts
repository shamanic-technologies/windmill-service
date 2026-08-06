/**
 * One-time repair: add the recipient-timezone mapping to the email-gateway send
 * node of every ACTIVE workflow whose fetch node actually serves one.
 *
 * Workflows are LLM-generated, and the authoring prompt never mentioned the
 * recipient timezone — so no stored DAG forwards it, and instantly-service
 * schedules every prospect on its US-Central default. The prompt is fixed
 * separately; already-stored DAGs are repaired here because they are never
 * regenerated.
 *
 * Deprecated workflows are out of scope.
 *
 * The $ref is derived per workflow from that workflow's own recipient mappings
 * (see src/lib/recipient-timezone-mapping.ts) — never hardcoded, because the
 * active DAGs disagree on both the producing object and its nesting.
 *
 * Idempotent and resumable: a workflow that already carries the mapping is left
 * untouched, so a second run reports zero changes.
 *
 * Usage:
 *   WORKFLOW_SERVICE_DATABASE_URL=postgresql://... \
 *   API_REGISTRY_SERVICE_URL=... API_REGISTRY_SERVICE_API_KEY=... \
 *   npx tsx scripts/backfill-recipient-timezone.ts --dry-run
 *
 * Drop --dry-run to write. API_REGISTRY_* is optional: when set, each rewritten
 * DAG is additionally checked against the live OpenAPI specs so the new $ref is
 * proven to resolve against what the fetch node really returns.
 */

import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { workflows } from "../src/db/schema.js";
import { validateDAG, type DAG } from "../src/lib/dag-validator.js";
import { computeDAGSignature } from "../src/lib/dag-signature.js";
import { extractHttpEndpoints } from "../src/lib/extract-http-endpoints.js";
import { validateWorkflowEndpoints } from "../src/lib/validate-workflow-endpoints.js";
import { fetchSpecsForServices } from "../src/lib/api-registry-client.js";
import {
  applyRecipientTimezoneMapping,
  TIMEZONE_BODY_KEY,
} from "../src/lib/recipient-timezone-mapping.js";

const DRY_RUN = process.argv.includes("--dry-run");

function hasTimezoneMapping(dag: DAG): boolean {
  return dag.nodes.some(
    (n) =>
      n.config?.service === "email-gateway" &&
      n.inputMapping?.[TIMEZONE_BODY_KEY] !== undefined,
  );
}

function hasEmailGatewayNode(dag: DAG): boolean {
  return dag.nodes.some((n) => n.config?.service === "email-gateway");
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE REPAIR ===");

  const active = await db.select().from(workflows).where(eq(workflows.status, "active"));
  const targets = active.filter((w) => hasEmailGatewayNode(w.dag as DAG));

  console.log(
    `Active workflows: ${active.length}; with an email-gateway node: ${targets.length}; ` +
      `already carrying ${TIMEZONE_BODY_KEY}: ${targets.filter((w) => hasTimezoneMapping(w.dag as DAG)).length}`,
  );

  // Specs are optional — without them the structural validator still runs.
  let specs = new Map<string, Record<string, unknown>>();
  if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
    const services = targets.flatMap((w) =>
      extractHttpEndpoints(w.dag as DAG).map((e) => e.service),
    );
    specs = await fetchSpecsForServices(services);
    console.log(`Fetched ${specs.size} OpenAPI spec(s) for deep $ref validation`);
  } else {
    console.warn("API_REGISTRY_* not set — skipping deep $ref validation against live specs");
  }

  let added = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const wf of targets) {
    const before = wf.dag as DAG;
    const { dag: after, plans, changed } = applyRecipientTimezoneMapping(before);

    for (const plan of plans) {
      if (plan.action === "add") {
        console.log(`  ${wf.workflowSlug} [${plan.nodeId}] + ${TIMEZONE_BODY_KEY} = ${plan.ref}`);
      } else if (plan.action === "already-present") {
        console.log(`  ${wf.workflowSlug} [${plan.nodeId}] already mapped — untouched`);
      } else {
        console.log(`  ${wf.workflowSlug} [${plan.nodeId}] SKIP — ${plan.reason}`);
      }
    }

    if (!changed) {
      if (plans.some((p) => p.action === "skip")) skipped++;
      else unchanged++;
      continue;
    }

    // Structural validation of the rewritten DAG.
    const structural = validateDAG(after);
    if (!structural.valid) {
      failed++;
      console.error(
        `  ${wf.workflowSlug} REFUSED — rewritten DAG fails validation: ` +
          structural.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
      );
      continue;
    }

    // Deep validation: the new $ref must resolve against the fetch node's real
    // response schema, and the rewrite must introduce no new issue of any kind.
    if (specs.size > 0) {
      const issuesBefore = validateWorkflowEndpoints(before, specs).fieldIssues;
      const issuesAfter = validateWorkflowEndpoints(after, specs).fieldIssues;
      const introduced = issuesAfter.filter(
        (a) => !issuesBefore.some((b) => b.reason === a.reason),
      );
      if (introduced.length > 0) {
        failed++;
        console.error(
          `  ${wf.workflowSlug} REFUSED — rewrite introduces field issue(s): ` +
            introduced.map((i) => i.reason).join("; "),
        );
        continue;
      }
    }

    // Nothing but the mapping may change.
    const strippedAfter = structuredClone(after);
    for (const node of strippedAfter.nodes) {
      if (node.inputMapping) delete node.inputMapping[TIMEZONE_BODY_KEY];
    }
    if (JSON.stringify(strippedAfter) !== JSON.stringify(before)) {
      failed++;
      console.error(`  ${wf.workflowSlug} REFUSED — rewrite changed more than ${TIMEZONE_BODY_KEY}`);
      continue;
    }

    if (DRY_RUN) {
      added++;
      continue;
    }

    await db
      .update(workflows)
      .set({ dag: after, signature: computeDAGSignature(after), updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));

    // Read back what actually landed rather than trusting the write.
    const [reread] = await db.select().from(workflows).where(eq(workflows.id, wf.id));
    if (!reread || !hasTimezoneMapping(reread.dag as DAG)) {
      failed++;
      console.error(`  ${wf.workflowSlug} WRITE VERIFY FAILED — row does not carry the mapping`);
      continue;
    }
    added++;
  }

  // Authoritative counts, read back from the database — not the loop's tally.
  const verify = (await db.select().from(workflows).where(eq(workflows.status, "active")))
    .filter((w) => hasEmailGatewayNode(w.dag as DAG));
  const carrying = verify.filter((w) => hasTimezoneMapping(w.dag as DAG)).length;

  console.log(
    `\nDone. ${DRY_RUN ? "Would add" : "Added"}: ${added}, already mapped: ${unchanged}, ` +
      `skipped: ${skipped}, failed: ${failed}`,
  );
  console.log(
    `DB now: ${carrying}/${verify.length} active email-gateway workflows carry ${TIMEZONE_BODY_KEY}`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
