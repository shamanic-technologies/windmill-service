#!/usr/bin/env node
/**
 * One-off ops script: stand up the first workflow set for the
 * `feedback-request-cold-email-outreach` feature.
 *
 * Twelve dynasties = three prompt angles x four "pro" model aliases. The angles
 * are descended from the three templates with the lowest cross-org
 * cost-per-positive-reply measured on 2026-08-19:
 *
 *   pr-cold-email-v22        $73.33 over 4 replies   -> feedback-request-giving-email-v1
 *   blind-discovery-email-v26 $95.34 over 15 replies -> feedback-request-blind-email-v1
 *   cold-email-v29           $97.74 over 1 reply     -> feedback-request-observation-email-v1
 *
 * The three winners all run on the chat-service default model, so the model is
 * the second axis rather than a copy of an existing choice: `pro` (Google) plus
 * the three direct-vendor "pro" aliases. Unlike the fleet's current workflows,
 * the Google cell writes `model: "pro"` explicitly. Leaving it absent works but
 * makes the model invisible in the stored DAG, which is what made "which model
 * do the winners use" a database question instead of a readable one.
 *
 * The DAG is the chassis of `sales-cold-email-outreach-granite`, unchanged
 * except for what this feature actually needs. Only `body.type` and
 * `body.model` differ from one cell to the next.
 *
 * IDEMPOTENCE — note this is enforced HERE, not by the route. `PUT /workflows/{id}`
 * answers a clean 409 when a DAG signature is already taken, but `POST /workflows`
 * has no such guard: it inserts straight into a partial unique index over
 * (feature_slug, signature) WHERE status='active', so a duplicate surfaces as a
 * raw Postgres 500. So the script reads the feature's active workflows first and
 * only creates the cells that are missing. Re-running is safe, and the dry run
 * walks exactly the same path as the real one.
 *
 * Usage, from inside the workflow-service container:
 *
 *   node seed-feedback-request-matrix.mjs --dry-run
 *   node seed-feedback-request-matrix.mjs --apply
 *
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080),
 *      ORG_ID (default below).
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const APPLY = process.argv.includes("--apply");

/**
 * The workflow row carries an org, but `GET /workflows?featureSlug=` only
 * narrows by org when the caller passes `orgId` as a QUERY param, and
 * campaign-service passes it as a header. So the feature's workflow list every
 * campaign resolves against is cross-org, and this org is bookkeeping: it is
 * the one already holding the largest share of the sales dynasties.
 */
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";

export const FEATURE_SLUG = "feedback-request-cold-email-outreach";

export const ANGLES = [
  {
    type: "feedback-request-giving-email-v1",
    description:
      "Feedback-request cold email, giving-first angle. Opens on an observation about the prospect, hands over the gift without conditioning it on their interest, then asks for their reaction. Descended from the PR pitch template.",
  },
  {
    type: "feedback-request-blind-email-v1",
    description:
      "Feedback-request cold email, blind angle. The client stays unnamed and the prospect's reply is what unlocks the gift. Descended from the blind-discovery template.",
  },
  {
    type: "feedback-request-observation-email-v1",
    description:
      "Feedback-request cold email, observation angle. Builds a hypothesis from the prospect's own signals, then offers the gift as what that hypothesis calls for. Descended from cold-email-v29.",
  },
];

/** The four "pro" aliases, one per vendor. Read off chat-service's deployed /complete schema. */
export const MODELS = ["pro", "deepseek-pro", "glm-pro", "kimi-pro"];

/**
 * The eight the customer fills in on the feature, plus the general brand
 * context the emails lean on. The first eight MUST stay byte-equal to the
 * feature's extraction keys in features-service, or the customer's own words
 * never reach the email and the extractor answers from the brand's website
 * instead. Verify against `GET /features/<slug>/inputs` before applying.
 */
export const OFFER_FIELDS = [
  { key: "giftOffer", description: "What the prospect receives in exchange for feedback: a free trial, the service offered, at-cost access, or early access. State it as the prospect would receive it." },
  { key: "giftValue", description: "What that gift is worth, anchored to its normal price, and what the relationship becomes once the feedback is given." },
  { key: "feedbackForm", description: "The form of feedback asked in return: a written testimonial private or public, a video testimonial private or public, a call, or a review on a public platform such as G2, Google Maps, Trustpilot or Capterra." },
  { key: "feedbackEffort", description: "How much time and effort the feedback costs the prospect, stated concretely. For example fifteen minutes on a call, three questions in writing, a sixty second video." },
  { key: "socialProof", description: "Trust signals that make the offer credible: how many people already took it, named customers, published results." },
  { key: "scarcity", description: "Limited availability, typically a number of seats in the tester programme. Empty when none genuinely applies." },
  { key: "urgency", description: "A deadline or closing cohort. Empty when none genuinely applies." },
  { key: "riskReversal", description: "What removes the risk of accepting: no commitment, no credit card, cancel at any time." },
];

const BRAND_CONTEXT_FIELDS = [
  { key: "companyOverview", description: "A comprehensive overview of the company" },
  { key: "valueProposition", description: "The company's core value proposition" },
  { key: "keyFeatures", description: "Key features of the company's product or service" },
  { key: "customerPainPoints", description: "Pain points the company solves for customers" },
  { key: "productDifferentiators", description: "What differentiates the product from competitors" },
  { key: "leadership", description: "Company leadership and key team members" },
  { key: "additionalContext", description: "Any additional relevant context about the company" },
];

/**
 * Every template declares {{currentDate}}. The fleet's existing DAGs do not
 * supply it, so it renders unresolved in the prompts that ask for it today.
 * This is the documented way to provide it.
 */
const GET_DATE_CODE =
  'export async function main() { return { currentDate: new Date().toISOString().split("T")[0] }; }';

export function buildDag(promptType, model) {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/gate-check",
          stopAfterIf: "result.allowed == false",
        },
      },
      {
        id: "start-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/start-run" },
      },
      {
        id: "fetch-lead",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
        retries: 0,
      },
      { id: "check-lead", type: "condition" },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:start-run.output.brandIds[0]" },
      },
      {
        id: "brand-extract-fields",
        type: "http.call",
        config: {
          service: "brand",
          method: "POST",
          path: "/orgs/brands/extract-fields",
          body: { fields: [...OFFER_FIELDS, ...BRAND_CONTEXT_FIELDS] },
        },
      },
      { id: "get-date", type: "script", config: { code: GET_DATE_CODE } },
      {
        id: "email-generate",
        type: "http.call",
        config: {
          service: "content-generation",
          method: "POST",
          path: "/generate",
          body: { type: promptType, model },
        },
        retries: 0,
        inputMapping: {
          "body.leadId": "$ref:fetch-lead.output.lead.leadId",
          "body.variables.currentDate": "$ref:get-date.output.currentDate",
          "body.variables.clientName": "$ref:brand-profile.output.brand.name",
          "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.currentTitle",
          "body.variables.leadHeadline": "$ref:fetch-lead.output.lead.data.headline",
          "body.variables.leadCompanyName": "$ref:fetch-lead.output.lead.data.organization.name",
          "body.variables.leadCompanyIndustry": "$ref:fetch-lead.output.lead.data.organization.industry",
          "body.variables.leadCompanySize": "$ref:fetch-lead.output.lead.data.organization.estimatedNumEmployees",
          "body.variables.leadCompanyDescription": "$ref:fetch-lead.output.lead.data.organization.shortDescription",
          "body.variables.leadCompanyKeywords": "$ref:fetch-lead.output.lead.data.organization.keywords",
          "body.variables.leadCompanyTechStack": "$ref:fetch-lead.output.lead.data.organization.technologyNames",
          "body.variables.giftOffer": "$ref:brand-extract-fields.output.fields.giftOffer.value",
          "body.variables.giftValue": "$ref:brand-extract-fields.output.fields.giftValue.value",
          "body.variables.feedbackForm": "$ref:brand-extract-fields.output.fields.feedbackForm.value",
          "body.variables.feedbackEffort": "$ref:brand-extract-fields.output.fields.feedbackEffort.value",
          "body.variables.socialProof": "$ref:brand-extract-fields.output.fields.socialProof.value",
          "body.variables.scarcity": "$ref:brand-extract-fields.output.fields.scarcity.value",
          "body.variables.urgency": "$ref:brand-extract-fields.output.fields.urgency.value",
          "body.variables.riskReversal": "$ref:brand-extract-fields.output.fields.riskReversal.value",
          "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output",
        },
      },
      {
        id: "email-send",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: {
            type: "broadcast",
            tag: "feedback-request-sequence-email",
            metadata: { source: "mcpfactory-campaign-service" },
          },
          validateResponse: { field: "success", equals: true },
        },
        retries: 0,
        inputMapping: {
          "body.to": "$ref:fetch-lead.output.lead.email",
          "body.leadId": "$ref:fetch-lead.output.lead.leadId",
          "body.subject": "$ref:email-generate.output.subject",
          "body.sequence": "$ref:email-generate.output.sequence",
          "body.timezone": "$ref:fetch-lead.output.lead.data.timezone",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.workflowSlug": "$ref:start-run.output.workflowSlug",
          "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
          "body.recipientLastName": "$ref:fetch-lead.output.lead.data.lastName",
          "body.recipientCompany": "$ref:fetch-lead.output.lead.data.organization.name",
          "body.metadata.emailGenerationId": "$ref:email-generate.output.id",
        },
      },
      {
        id: "end-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      {
        id: "end-run-no-lead",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: true },
        },
      },
      {
        id: "end-run-error",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: false, stopCampaign: false },
        },
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "fetch-lead" },
      { from: "fetch-lead", to: "check-lead" },
      { from: "check-lead", to: "brand-profile", condition: "results['fetch-lead'].found == true" },
      { from: "check-lead", to: "end-run-no-lead", condition: "results['fetch-lead'].found == false" },
      { from: "brand-profile", to: "brand-extract-fields" },
      { from: "brand-extract-fields", to: "get-date" },
      { from: "get-date", to: "email-generate" },
      { from: "email-generate", to: "email-send" },
      { from: "email-send", to: "end-run" },
    ],
    onError: "end-run-error",
  };
}

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

/** The (prompt type, model) pair a stored DAG encodes, or null if it has no generation step. */
export function cellOf(dag) {
  const node = (dag?.nodes ?? []).find((n) => n?.config?.service === "content-generation");
  if (!node) return null;
  const body = node.config?.body ?? {};
  // A DAG with no explicit model runs on the chat-service default, which is `pro`.
  return `${body.type}::${body.model ?? "pro"}`;
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

  console.log(`${FEATURE_SLUG}: ${existing.payload?.workflows?.length ?? 0} active workflow(s), ${covered.size} cell(s) covered`);
  console.log(APPLY ? "APPLY" : "DRY RUN (pass --apply to write)");

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const angle of ANGLES) {
    for (const model of MODELS) {
      const cell = `${angle.type}::${model}`;
      if (covered.has(cell)) {
        console.log(`  ${cell}: already covered by ${covered.get(cell)}`);
        skipped += 1;
        continue;
      }

      if (!APPLY) {
        console.log(`  ${cell}: would create`);
        created += 1;
        continue;
      }

      const { status, payload } = await call("POST", "/workflows", {
        featureSlug: FEATURE_SLUG,
        description: `${angle.description} Generated with ${model}.`,
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        tags: ["email", "feedback-request", model],
        dag: buildDag(angle.type, model),
      });

      if (status === 201) {
        console.log(`  ${cell}: created ${payload?.workflowDynastySlug}`);
        covered.set(cell, payload?.workflowDynastySlug);
        created += 1;
      } else {
        console.error(`  ${cell}: FAILED ${status} ${JSON.stringify(payload)}`);
        failed += 1;
      }
    }
  }

  console.log(`\n${created} created, ${skipped} already covered, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Importable by the test suite; only runs when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
