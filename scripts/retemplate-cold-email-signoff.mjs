#!/usr/bin/env node
/**
 * Re-point every workflow that still carries a "Kevin from [ClientName]" cold-email
 * prompt template at its sign-off-free successor.
 *
 *   cold-email-v27 -> cold-email-v39
 *   cold-email-v28 -> cold-email-v40
 *   cold-email-v29 -> cold-email-v41
 *
 * The v39/v40/v41 rows already exist in content-generation-service; they are
 * byte-identical to their predecessor except that the sign-off is no longer
 * prescribed (the model picks it), the em dashes are gone from the instruction
 * text, the "why this works" paragraph leads with the relationship framing, and
 * the tone kill-list names machine-written tells explicitly. v41 additionally
 * reverts the pitch paragraph from "we handle" to "they handle", which only made
 * sense while the sign-off claimed membership of the client's team.
 *
 * Every affected workflow is upgraded IN ITS OWN DYNASTY (POST /workflows/upgrade
 * with a client-supplied DAG, no LLM round-trip) so the dynasty slug that
 * campaign-service holds keeps resolving. Nothing is forked.
 *
 * Three lifecycle shapes need three different call sequences, because
 * /workflows/upgrade resolves a dynasty by its ACTIVE version and a workflow that
 * is parked or retired has none:
 *
 *   live     version active, dynasty active   -> upgrade
 *   parked   dynasty active, no active version -> activate the head, upgrade, re-park the new head
 *   retired  dynasty deprecated               -> un-retire, upgrade, re-retire
 *
 * Idempotent: a dynasty whose head already runs the successor template is skipped,
 * so a run interrupted by the creation rate limit can simply be re-run.
 *
 * Usage:
 *   node scripts/retemplate-cold-email-signoff.mjs             # dry run
 *   node scripts/retemplate-cold-email-signoff.mjs --apply
 *   node scripts/retemplate-cold-email-signoff.mjs --apply --only sales-cold-email-outreach-ballad
 *
 * Env: WORKFLOW_SERVICE_URL, WORKFLOW_SERVICE_API_KEY, RETEMPLATE_USER_ID
 */

import { randomUUID } from "node:crypto";

const BASE = process.env.WORKFLOW_SERVICE_URL;
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const USER_ID = process.env.RETEMPLATE_USER_ID;

if (!BASE || !API_KEY || !USER_ID) {
  console.error("WORKFLOW_SERVICE_URL, WORKFLOW_SERVICE_API_KEY and RETEMPLATE_USER_ID are required");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : process.argv[i + 1];
})();

const FEATURE_SLUG = "sales-cold-email-outreach";
const PROMPT_MAP = {
  "cold-email-v27": "cold-email-v39",
  "cold-email-v28": "cold-email-v40",
  "cold-email-v29": "cold-email-v41",
};

/**
 * POST /workflows/upgrade is rate limited to 10 creations per minute per org
 * (createRateLimit). Space the upgrades out rather than retrying a 429 in
 * process — a swallowed 429 would make a partially-applied run read as a clean
 * one. Anything that still fails is re-covered by re-running the script.
 */
const UPGRADE_SPACING_MS = 8_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(orgId) {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": orgId,
    "x-user-id": USER_ID,
    "x-run-id": randomUUID(),
  };
}

async function call(method, path, orgId, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(orgId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/** The prompt template a DAG's content-generation node asks for, or null. */
function promptTypeOf(dag) {
  for (const node of dag?.nodes ?? []) {
    if (node?.config?.service === "content-generation" && typeof node.config?.body?.type === "string") {
      return node.config.body.type;
    }
  }
  return null;
}

/** A copy of the DAG whose content-generation node asks for `next` instead. */
function repointDag(dag, next) {
  const copy = structuredClone(dag);
  for (const node of copy.nodes) {
    if (node?.config?.service === "content-generation" && typeof node.config?.body?.type === "string") {
      node.config.body.type = next;
    }
  }
  return copy;
}

async function main() {
  // The discovery org only has to satisfy requireIdentity — neither the public
  // list nor GET /workflows/:id is org-scoped. Writes use each row's OWN org, so
  // an upgraded version lands under the same org as the version it replaces.
  const probeOrg = randomUUID();

  const listed = await call(
    "GET",
    `/public/workflows?featureSlugs=${FEATURE_SLUG}&status=all`,
    probeOrg,
  );

  // The list carries no DAG, so every row needs its own read. Fan them out a few
  // at a time: the feature has hundreds of versions and one-at-a-time discovery
  // costs minutes before the first line of output.
  const successors = new Set(Object.values(PROMPT_MAP));
  const queue = [...listed.workflows];
  const rows = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const full = await call("GET", `/workflows/${item.id}`, probeOrg);
        const promptType = promptTypeOf(full.dag);
        if (!promptType) continue;
        if (!(promptType in PROMPT_MAP) && !successors.has(promptType)) continue;
        rows.push(full);
      }
    }),
  );

  // Group by dynasty: the upgrade acts on a lineage, not on a row.
  const byDynasty = new Map();
  for (const row of rows) {
    const list = byDynasty.get(row.workflowDynastySlug) ?? [];
    list.push(row);
    byDynasty.set(row.workflowDynastySlug, list);
  }

  const plan = [];
  for (const [slug, versions] of byDynasty) {
    if (ONLY && slug !== ONLY) continue;
    versions.sort((a, b) => b.version - a.version);
    const head = versions.find((v) => v.status === "active") ?? versions[0];
    const promptType = promptTypeOf(head.dag);

    if (!(promptType in PROMPT_MAP)) {
      plan.push({ slug, head, shape: "skip", reason: `head already on ${promptType}` });
      continue;
    }

    const dynastyRetired = head.workflowDynastyStatus === "deprecated";
    const shape = dynastyRetired ? "retired" : head.status === "active" ? "live" : "parked";
    plan.push({ slug, head, shape, from: promptType, to: PROMPT_MAP[promptType] });
  }

  plan.sort((a, b) => a.slug.localeCompare(b.slug));

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${plan.length} dynasties matched\n`);
  for (const p of plan) {
    if (p.shape === "skip") {
      console.log(`  skip     ${p.slug.padEnd(42)} ${p.reason}`);
      continue;
    }
    console.log(`  ${p.shape.padEnd(8)} ${p.slug.padEnd(42)} v${p.head.version} ${p.from} -> ${p.to}`);
  }

  const work = plan.filter((p) => p.shape !== "skip");
  if (!APPLY) {
    console.log(`\n${work.length} would be upgraded. Re-run with --apply.\n`);
    return;
  }

  console.log("");
  let done = 0;
  for (const p of work) {
    const org = p.head.orgId;
    const dag = repointDag(p.head.dag, p.to);

    if (p.shape === "retired") {
      await call("PUT", `/workflows/dynasty/${p.slug}/status`, org, { status: "active" });
    } else if (p.shape === "parked") {
      await call("PUT", `/workflows/${p.head.id}/status`, org, { status: "active" });
    }

    const upgraded = await call("POST", "/workflows/upgrade", org, {
      workflowDynastySlug: p.slug,
      dag,
    });
    const created = upgraded.workflow;

    if (p.shape === "retired") {
      await call("PUT", `/workflows/dynasty/${p.slug}/status`, org, { status: "deprecated" });
    } else if (p.shape === "parked") {
      await call("PUT", `/workflows/${created.id}/status`, org, { status: "deprecated" });
    }

    done += 1;
    console.log(`  ok ${String(done).padStart(2)}/${work.length}  ${p.shape.padEnd(8)} ${created.workflowSlug} (v${created.version}, ${p.to})`);

    if (done < work.length) await sleep(UPGRADE_SPACING_MS);
  }

  console.log(`\n${done} dynasties upgraded.\n`);
}

await main();
