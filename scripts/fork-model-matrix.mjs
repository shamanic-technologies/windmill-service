#!/usr/bin/env node
/**
 * One-off ops script: fan every active `sales-cold-email-outreach` dynasty out
 * across the six direct-vendor model aliases (DeepSeek / Z.ai / Moonshot).
 *
 * The model an email is generated with lives in the DAG, on the
 * content-generation `/generate` node: `config.body.model`. Absent means the
 * chat-service default (`pro`). So a "same workflow, different model" variant is
 * the same DAG with that one field rewritten — which changes the DAG signature,
 * and a changed signature on `PUT /workflows/:id` is exactly the FORK path.
 *
 * Two operations, in this order:
 *
 *   1. RECYCLE — three forks created on 2026-08-15 carry `deepseek-flash-v4`,
 *      an alias chat-service does not serve, so their dynasties were parked as
 *      `workflow_dynasty_status='deprecated'`. Rather than leave three burned
 *      dynasty names behind, each is upgraded in place to a valid alias via
 *      `POST /workflows/upgrade` (same dynasty, new version) and its dynasty
 *      status flipped back to active. The upgrade route does not write
 *      `workflow_dynasty_status`, so the flip is a separate explicit call.
 *
 *   2. FORK — every (dynasty x model) pair not already covered.
 *
 * Idempotent by construction: a DAG that already exists as an active workflow
 * collides on signature and the route answers 409, which is recorded as
 * "already covered" rather than an error. Re-running is therefore safe, and the
 * dry run and the real run walk exactly the same code path.
 *
 * Usage (from inside the workflow-service container, which can reach its own
 * port and holds no psql):
 *
 *   node fork-model-matrix.mjs --dry-run
 *   node fork-model-matrix.mjs --apply
 *
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080).
 */

import { randomUUID } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const APPLY = process.argv.includes("--apply");

if (!API_KEY) {
  console.error("WORKFLOW_SERVICE_API_KEY is required");
  process.exit(1);
}

/**
 * The six direct-vendor aliases, read off chat-service's deployed `/complete`
 * schema (chat-service src/lib/anthropic.ts MODEL_MAP, mirrored in
 * content-generation-service src/lib/chat-models.ts). Version-free on purpose:
 * the provider is derived from the alias, callers never pass a provider.
 */
const MODELS = [
  "deepseek-flash",
  "deepseek-pro",
  "glm-flash",
  "glm-pro",
  "kimi-flash",
  "kimi-pro",
];

/**
 * The twelve active dynasties, with the org that owns each. Two orgs are
 * involved, and the fork inherits the source row's org, so each call must
 * carry the owning org's identity or the route resolves the wrong scope.
 */
const TARGETS = [
  { dyn: "arcadia", id: "7d5af7ba-00f5-49e7-9704-d5f4963a0379", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110" },
  { dyn: "azalea", id: "44684c78-9039-4a99-aaaf-45bc0e28d295", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110" },
  { dyn: "ballad", id: "10a1ecbf-a7f7-4da3-bb7f-010adde53b4d", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110" },
  { dyn: "dawn", id: "deb11950-3365-48b1-8752-0665758c5db8", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "granite", id: "75b63b3a-1e13-4712-add0-0cd36c225dd7", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110" },
  { dyn: "legato", id: "d01165f2-768b-42f7-8df2-98b035f02527", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "lithium", id: "7912edd1-f910-4cea-9c5b-c0761ce1e33f", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "osprey", id: "6f477669-5c6b-4558-a3fc-15fd92409dfd", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "pelican", id: "61ec8a0a-36fc-4948-bc09-773fe23521dc", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "permafrost", id: "6222c427-0f4f-43fe-aa75-1932bb6a0fe2", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "rampart", id: "70fc96ea-dc79-4a7a-96b2-11706398709e", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6" },
  { dyn: "vector", id: "94f19f37-9161-4296-855a-92066ebd267b", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110" },
];

/**
 * The three dynasties parked on the invalid alias, and the alias each is being
 * moved to. `deepseek-pro` is the free cell in each of their rows: their
 * `deepseek-flash` variant already exists (condor / lawrencium / pioneer, forked
 * off these same three on 2026-08-15).
 */
const RECYCLE = [
  { dynastySlug: "sales-cold-email-outreach-cerulean", id: "484c4a9a-998f-4d8e-be97-11747804600d", orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6", model: "deepseek-pro" },
  { dynastySlug: "sales-cold-email-outreach-rudder", id: "46d31049-2f4c-474a-8088-ba819a6ac4ed", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110", model: "deepseek-pro" },
  { dynastySlug: "sales-cold-email-outreach-allegro", id: "1e53dc71-36e6-4014-90d3-43c4b3aaae1f", orgId: "c1f7c82f-c625-4d63-b8b5-e238c6c6a110", model: "deepseek-pro" },
];

function headers(orgId) {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": orgId,
    "x-user-id": randomUUID(),
    "x-run-id": randomUUID(),
  };
}

async function call(method, path, orgId, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(orgId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload };
}

/**
 * The content-generation call is the only node in these DAGs that posts to
 * `/generate`; that is where the model belongs. Locating it by path rather than
 * by node id keeps this working across the twelve DAGs, which do not agree on
 * node naming.
 */
function findGenerateNode(dag) {
  return dag.nodes.find((n) => n.config?.path === "/generate" && n.config?.body?.type);
}

function withModel(dag, model) {
  const clone = structuredClone(dag);
  const node = findGenerateNode(clone);
  if (!node) throw new Error("no content-generation /generate node in DAG");
  node.config.body.model = model;
  return clone;
}

const results = [];

async function recycle() {
  for (const r of RECYCLE) {
    const got = await call("GET", `/workflows/${r.id}`, r.orgId);
    if (got.status !== 200) {
      results.push({ op: "recycle", target: r.dynastySlug, model: r.model, outcome: `GET FAILED ${got.status}` });
      continue;
    }
    const current = got.payload.dag;
    const tmpl = findGenerateNode(current)?.config?.body?.type;
    const before = findGenerateNode(current)?.config?.body?.model;

    if (before === r.model) {
      results.push({ op: "recycle", target: r.dynastySlug, tmpl, model: r.model, outcome: "already on target alias" });
      continue;
    }
    if (!APPLY) {
      results.push({ op: "recycle", target: r.dynastySlug, tmpl, model: r.model, outcome: `would upgrade ${before} -> ${r.model} + reactivate dynasty` });
      continue;
    }

    const up = await call("POST", "/workflows/upgrade", r.orgId, {
      workflowDynastySlug: r.dynastySlug,
      dag: withModel(current, r.model),
    });
    if (up.status !== 200 && up.status !== 201) {
      results.push({ op: "recycle", target: r.dynastySlug, tmpl, model: r.model, outcome: `UPGRADE FAILED ${up.status} ${JSON.stringify(up.payload)}` });
      continue;
    }
    const act = await call("PUT", `/workflows/dynasty/${r.dynastySlug}/status`, r.orgId, { status: "active" });
    results.push({
      op: "recycle",
      target: r.dynastySlug,
      tmpl,
      model: r.model,
      outcome: `upgraded -> ${up.payload?.workflow?.workflowSlug} (v${up.payload?.workflow?.version}), reactivate ${act.status}`,
    });
  }
}

async function forkMatrix() {
  for (const t of TARGETS) {
    const got = await call("GET", `/workflows/${t.id}`, t.orgId);
    if (got.status !== 200) {
      results.push({ op: "fork", target: t.dyn, outcome: `GET FAILED ${got.status}` });
      continue;
    }
    const dag = got.payload.dag;
    const gen = findGenerateNode(dag);
    const tmpl = gen?.config?.body?.type;
    const baseModel = gen?.config?.body?.model ?? "pro (default)";

    for (const model of MODELS) {
      if (!APPLY) {
        results.push({ op: "fork", target: t.dyn, tmpl, base: baseModel, model, outcome: "would fork" });
        continue;
      }
      const put = await call("PUT", `/workflows/${t.id}`, t.orgId, { dag: withModel(dag, model) });
      if (put.status === 201) {
        results.push({ op: "fork", target: t.dyn, tmpl, model, outcome: `created ${put.payload.workflowSlug}` });
      } else if (put.status === 409) {
        results.push({ op: "fork", target: t.dyn, tmpl, model, outcome: `already covered by ${put.payload.existingWorkflowSlug}` });
      } else {
        results.push({ op: "fork", target: t.dyn, tmpl, model, outcome: `FAILED ${put.status} ${JSON.stringify(put.payload)}` });
      }
    }
  }
}

await recycle();
await forkMatrix();

console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");
for (const r of results) {
  console.log(
    [r.op, r.target, r.tmpl ?? "", r.model ?? "", r.outcome].join(" | "),
  );
}
const failed = results.filter((r) => String(r.outcome).includes("FAILED"));
console.log(`\n${results.length} operations, ${failed.length} failed`);
if (failed.length) process.exit(1);
