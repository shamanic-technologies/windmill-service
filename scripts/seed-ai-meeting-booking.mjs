#!/usr/bin/env node
/**
 * Ops script: stand up the workflow behind the `ai-meeting-booking` channel.
 *
 * The channel answers the prospects who showed sales interest and books the
 * meeting: it performs the `conversation_to_meeting_booked` leg of the
 * `sales_meetings_from_conversation` funnel. Everything underneath it already
 * runs; this is the thing that runs.
 *
 * ONE dynasty, not a matrix. The cold-email channels fan out across prompt
 * angles and models because they are looking for the one that converts; there
 * is nothing to compare here yet — the first question is whether the answer
 * lands at all, and a second cell would only split the evidence.
 *
 * IDEMPOTENCE — enforced HERE as well as by the route. `POST /workflows` answers
 * a clean 409 on a duplicate signature, but a 409 per already-covered cell is
 * noise and it is what makes a rate-limited batch impossible to resume. So the
 * script reads the feature's active workflows first and creates only what is
 * missing. Re-running is safe, and the dry run walks the same path as the real
 * one.
 *
 * Usage, from inside the workflow-service container:
 *
 *   node seed-ai-meeting-booking.mjs            # dry run
 *   node seed-ai-meeting-booking.mjs --apply
 *
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080),
 *      ORG_ID (default below).
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  FEATURE_SLUG,
  buildAiMeetingBookingDag,
} from "../dist/lib/ai-meeting-booking-dag.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const APPLY = process.argv.includes("--apply");

/**
 * The workflow row carries an org, but `GET /workflows?featureSlug=` only
 * narrows by org when the caller passes `orgId` as a QUERY param, and
 * campaign-service passes it as a header. So the feature's workflow list every
 * campaign resolves against is cross-org, and this org is bookkeeping: the one
 * already holding the largest share of the sales dynasties.
 */
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";

/** The model the answer is drafted with, through chat-service. */
export const CELL = { provider: "google", model: "pro" };

export const DESCRIPTION =
  "Answers one prospect who showed sales interest and is owed our next message. " +
  "Claims them from the campaign's follow-up queue, reads what they wrote and what we already sent, " +
  "answers the question they actually asked, proposes two concrete slots in their own timezone read " +
  "from the brand's booking page for this funnel, sends it as a reply in their existing thread from " +
  "the mailbox that contacted them, and then records the answer and when the next one is owed.";

function headers() {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": ORG_ID,
    "x-user-id": randomUUID(),
    "x-run-id": randomUUID(),
  };
}

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
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

/** The (provider, model) a stored DAG drafts with, or null if it has no drafting step. */
export function cellOf(dag) {
  const node = (dag?.nodes ?? []).find((n) => n?.config?.service === "chat");
  if (!node) return null;
  const body = node.config?.body ?? {};
  return `${body.provider}::${body.model}`;
}

async function main() {
  if (!API_KEY) {
    console.error("WORKFLOW_SERVICE_API_KEY is required");
    process.exit(1);
  }

  const existing = await call("GET", `/workflows?featureSlug=${FEATURE_SLUG}&status=active`);
  if (existing.status !== 200) {
    console.error(`Could not list existing workflows: ${existing.status} ${JSON.stringify(existing.payload)}`);
    process.exit(1);
  }

  const covered = new Map();
  for (const w of existing.payload?.workflows ?? []) {
    const cell = cellOf(w.dag);
    if (cell) covered.set(cell, w.workflowDynastySlug ?? w.workflowSlug);
  }

  const cell = `${CELL.provider}::${CELL.model}`;
  console.log(`${FEATURE_SLUG}: ${existing.payload?.workflows?.length ?? 0} active workflow(s)`);
  console.log(APPLY ? "APPLY" : "DRY RUN (pass --apply to write)");

  if (covered.has(cell)) {
    console.log(`  ${cell}: already covered by ${covered.get(cell)}`);
    return;
  }

  if (!APPLY) {
    console.log(`  ${cell}: would create`);
    return;
  }

  const { status, payload } = await call("POST", "/workflows", {
    featureSlug: FEATURE_SLUG,
    description: DESCRIPTION,
    // Provenance, not behaviour: this converts an existing conversation rather
    // than opening one, so it is not cold outreach.
    category: "sales",
    channel: "email",
    audienceType: "conversation-follow-up",
    tags: ["email", "meeting-booking", "reply", CELL.model],
    dag: buildAiMeetingBookingDag(CELL),
  });

  if (status === 201) {
    console.log(`  ${cell}: created ${payload?.workflowDynastySlug}`);
    return;
  }
  if (status === 409) {
    console.log(`  ${cell}: already exists (${payload?.workflowSlug ?? "unknown"})`);
    return;
  }
  console.error(`  ${cell}: FAILED ${status} ${JSON.stringify(payload)}`);
  process.exitCode = 1;
}

// Importable by the test suite; only runs when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
