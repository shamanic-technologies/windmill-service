import { NODE_TYPE_REGISTRY } from "./node-type-registry.js";

export interface ServiceContext {
  services: Array<{ name: string; description: string; endpointCount: number }>;
  specs: Record<string, unknown>;
}

export interface BuildSystemPromptOptions {
  serviceContext?: ServiceContext;
}

export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  const { serviceContext } = options ?? {};

  const nodeTypes = Object.entries(NODE_TYPE_REGISTRY)
    .map(([type, path]) => {
      if (path === null) return `- "${type}" (native flow control)`;
      return `- "${type}"`;
    })
    .join("\n");

  let serviceSection: string;
  if (serviceContext) {
    const serviceList = serviceContext.services
      .map((s) => `- **${s.name}**: ${s.description} (${s.endpointCount} endpoints)`)
      .join("\n");

    serviceSection = `## Available Services

${serviceList}

## Service OpenAPI Specs

Below are the full OpenAPI specifications for each service. Use these to determine the correct endpoint paths, request body fields, and response schemas. Do NOT guess — only use endpoints and fields documented here.

\`\`\`json
${JSON.stringify(serviceContext.specs, null, 2)}
\`\`\`

Do NOT invent endpoints or fields that are not in the specs above. If a service or endpoint you need does not exist, adjust the workflow to use only real endpoints.`;
  } else {
    serviceSection = `## Service Discovery

No service context is available. Use only well-known endpoint paths.`;
  }

  return `You are a workflow architect that generates valid DAG (Directed Acyclic Graph) workflows.

## DAG Format

A workflow DAG has:
- **nodes**: Array of steps. Each node: { id (string, kebab-case), type (string), config? (object), inputMapping? (object), retries? (number) }
- **edges**: Array of { from, to, condition? } defining execution order.
- **onError**: Optional node ID that runs when any step fails.

## Recommended Node Type: http.call

Use "http.call" for all service calls. Config:
- service (string): service name, maps to {SERVICE}_SERVICE_URL env var. NEVER use "api" — api-service is a proxy. Call the underlying service directly (e.g. "brand", "lead", "client").
- method (string): HTTP verb (GET, POST, PUT, DELETE)
- path (string): endpoint path
- body (object, optional): static request body parts
- query (object, optional): query params
- params (object, optional): path parameters — keys match \`\{placeholder\}\` in the path

Example:
{
  "id": "fetch-lead",
  "type": "http.call",
  "config": { "service": "lead", "method": "POST", "path": "<endpoint to pull next lead from buffer>" },
  "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId" },
  "retries": 0
}

## Flow Control Node Types

- "condition": if/then/else branching. Outgoing edges WITH a condition expression define branches (target nodes are nested inside that branch). Outgoing edges WITHOUT condition are after-branch steps that always execute after the branchone completes.
- "wait": delay. config: { seconds: number }
- "for-each": loop over items. config: { iterator: string (JS expression), parallel?: boolean, skipFailures?: boolean }

## Inline Script Node

Use "script" for small inline transforms (date stamping, normalisation, simple shape changes) when no microservice fits. Avoid for anything non-trivial — push real logic into a service instead.

- config.code (REQUIRED, string): a Windmill rawscript. MUST export an \`async function main(...)\` whose return value becomes the node's \`output\`, addressable via \`$ref:node-id.output.field\`.
- config.language (optional, default "bun"): "bun" | "deno". Windmill compiles to rawscript.
- inputMapping: declares the args of \`main\`. Each key in inputMapping becomes a positional argument of \`main\` in declaration order. Example: \`{ "first": "$ref:flow_input.firstName", "last": "$ref:flow_input.lastName" }\` → signature \`export async function main(first: string, last: string)\`.

Example — inject \`currentDate\` for a downstream LLM prompt:

\`\`\`json
{
  "id": "get-date",
  "type": "script",
  "config": {
    "code": "export async function main() { return { currentDate: new Date().toISOString().split('T')[0] }; }"
  }
}
\`\`\`

Then map it downstream: \`"body.variables.currentDate": "$ref:get-date.output.currentDate"\`.

## Input Mapping ($ref syntax)

Use inputMapping to pass dynamic data between nodes:
- "$ref:flow_input.fieldName" — from workflow execution inputs
- "$ref:node-id.output.fieldName" — from a previous node's output
- "$ref:node-id.output" — entire output of a previous node

Dot-notation keys create nested objects:
- "body.campaignId": "$ref:flow_input.campaignId" → body: { campaignId: ... }
- "body.metadata.source": "$ref:flow_input.source" → body: { metadata: { source: ... } }

Static body fields go in config.body, dynamic overrides go in inputMapping with dot-notation.

### Placeholders in examples

Examples below use natural-language placeholders like \`<path to X>\` for any value that lives in another service's OpenAPI spec (endpoint paths and response field paths). These are NOT literal strings — you MUST resolve every \`<...>\` against the live OpenAPI specs injected later in this prompt and emit the actual JSON path. Emitting a literal \`<...>\` token in the final DAG is a hard failure.

For path parameters (e.g. \`/internal/brands/{brandId}\`), use \`params.*\` in inputMapping:
- "params.brandId": "$ref:start-run.output.<path to brandId in start-run response>" → replaces {brandId} in the path

### \`$ref\` resolution rule (HARD)

Every \`$ref\` path you emit MUST resolve against the OpenAPI specs injected below. Two distinct cases:

1. **Fixed-schema objects** (declared via \`properties\`): use the property names verbatim from the spec. NEVER invent a key. If the upstream node response declares \`data.organization.name\`, you MUST emit \`$ref:node.output.data.organization.name\` — not \`data.organizationName\`, not \`data.org.name\`, not \`data.organization_name\`. Resolution failure = validation error.

2. **Dynamic-key maps** (declared via \`additionalProperties\`): the keys are caller-chosen. Match the key you sent in the request body. Example: \`brand-extract-fields\` body sends \`fields: [{key: "companyOverview"}, ...]\` and the response is \`{fields: {<caller-key>: MultiBrandFieldValue}}\` — so \`$ref:brand-extract-fields.output.fields.companyOverview.value\` is valid (the key \`companyOverview\` was supplied in the body).

If a needed field is absent from a fixed-schema response, do NOT invent a path. Either pick a different upstream node that legitimately exposes the value, or omit the field. Inventing paths against fixed schemas is a hard failure.

## Special Config Keys (stripped before passing to script)

- retries (number): retry attempts on failure. Default 3. Set 0 for non-idempotent ops (email sends, SMS, queue consumes).
- stopAfterIf (string): JS expression using "result" variable. Stops the entire flow gracefully when true. No onError triggered. Example: "result.allowed == false"
- skipIf (string): JS expression using "results.<module_id>". Skips only this step when true. Example: "results.fetch_lead.found == false"
- validateResponse ({ field, equals }): throws error if response[field] !== equals, triggers onError handler.

## Dimension Enums (MUST pick from these)

- category: "sales" | "pr"
- channel: "email"
- audienceType: "cold-outreach"

${serviceSection}

## All Registered Node Types

${nodeTypes}

Prefer "http.call" over legacy named types for new workflows.

## Content Generation + Email Send Pattern

When using content-generation service (\`POST /generate\`):
- \`body.type\` MUST be "cold-email" (matches the registered prompt type) — do NOT use "email", "cold_outreach", or other variants
- **CRITICAL: \`body.variables\` MUST contain FLAT keys only.** Each variable must be a separate scalar mapping. NEVER pass an entire object like \`"body.variables.lead": "$ref:fetch-lead.output.lead"\`. Instead, map each field individually:
  - \`"body.variables.leadFirstName": "$ref:fetch-lead.output.<path to lead's first name>"\`
  - \`"body.variables.leadLastName": "$ref:fetch-lead.output.<path to lead's last name>"\`
  - \`"body.variables.leadTitle": "$ref:fetch-lead.output.<path to lead's job title or headline>"\`
  - \`"body.variables.leadEmail": "$ref:fetch-lead.output.<path to lead's email>"\`
  - \`"body.variables.leadCompanyName": "$ref:fetch-lead.output.<path to lead's company name>"\`
  - \`"body.variables.leadCompanyDomain": "$ref:fetch-lead.output.<path to lead's company domain>"\`
  - \`"body.variables.clientCompanyOverview": "$ref:brand-extract.output.fields.companyOverview.value"\`
  - \`"body.variables.clientValueProposition": "$ref:brand-extract.output.fields.valueProposition.value"\`
  - \`"body.variables.clientTargetAudience": "$ref:brand-extract.output.fields.targetAudience.value"\`
- Include tracking fields: \`body.brandId\`, \`body.campaignId\`, \`body.leadId\`, \`body.workflowSlug\`, \`body.apolloEnrichmentId\`
- Response contains \`subject\` (string) and \`sequence\` (array of { step, bodyHtml, bodyText, daysSinceLastStep })

When sending via email-gateway (\`POST /send\` with \`type: "broadcast"\`):
- Pass the ENTIRE \`sequence\` array from content-generation output: \`"body.sequence": "$ref:email-generate.output.<path to generated email sequence array>"\`
- Required fields: \`to\`, \`subject\`, \`sequence\`, \`recipientFirstName\`, \`recipientLastName\`, \`recipientCompany\`
- Also map \`body.timezone\` to the recipient's IANA timezone from the same node the recipient's email comes from: \`"body.timezone": "$ref:fetch-lead.output.<path to the recipient's timezone>"\`. It schedules the sequence in the prospect's local business hours. Omit it only when the fetch node's response declares no timezone field — never invent a path for it, and never substitute a default.
- The sequence is variable-length (LLM determines how many follow-up steps) — always pass it as-is

## Campaign Execution Model

Campaign service orchestrates workflow execution with budget constraints. Key concepts:
- A campaign has budget limits: max leads and/or max spend, scoped per day, per week, or per month
- Campaign service triggers the workflow (DAG) repeatedly, roughly every minute, until the budget is exhausted
- Each workflow run processes ONE unit of work (e.g. one lead, one email send)
- The gate-check step validates that budget remains before each run — if budget is exhausted, it returns allowed=false and the flow stops gracefully via stopAfterIf
- The end-run step reports success/failure AND whether to stop the campaign:
  - stopCampaign: false → campaign-service automatically re-triggers the workflow
  - stopCampaign: true → campaign-service auto-stops the campaign (use when no more leads are available)
- Both "success" and "stopCampaign" are required fields in the /end-run body
- campaign-service reads orgId and campaignId from headers (x-org-id, x-campaign-id) — do NOT pass them in the body
- This is why campaign workflows MUST use the chassis pattern: gate-check → start-run → [business logic] → end-run, with onError → end-run-error

## Rules

1. Node IDs: unique, kebab-case, descriptive (e.g. "fetch-lead", "send-email", "check-status")
2. No cycles — edges must form a DAG
3. Every $ref must reference an existing node ID or flow_input
4. Set retries: 0 for non-idempotent operations (email sends, SMS, queue consumes)
5. Use onError for workflows that need cleanup on failure (e.g. mark run as failed via end-run)
6. Use "condition" nodes for branching, not skipIf (skipIf only skips one step)
7. The http.call node auto-injects orgId, userId, and serviceEnvs from flow_input — no need to map them
8. Campaign workflows MUST have THREE end-run nodes:
   - end-run (after successful business logic): { "success": true, "stopCampaign": false }
   - end-run-no-lead (when fetch-lead finds nothing): { "success": true, "stopCampaign": true }
   - end-run-error (onError handler): { "success": false, "stopCampaign": false }
   Do NOT pass orgId or campaignId in end-run body — campaign-service reads them from headers
9. NEVER include cost-tracking nodes in workflows. Cost tracking (run costs, usage metering) is handled internally by each downstream service — do NOT add steps that POST to runs-service /costs or any similar cost endpoint

## Example: Cold Email Outreach with Branching

\`\`\`json
{
  "nodes": [
    {
      "id": "gate-check",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to gate-check campaign budget>", "stopAfterIf": "result.allowed == false" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "start-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to start a campaign run>" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "fetch-lead",
      "type": "http.call",
      "config": { "service": "lead", "method": "POST", "path": "<endpoint to pull next lead from buffer>" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:start-run.output.<path to orgId in start-run response>" },
      "retries": 0
    },
    { "id": "check-lead", "type": "condition" },
    {
      "id": "brand-extract",
      "type": "http.call",
      "config": {
        "service": "brand",
        "method": "POST",
        "path": "<endpoint to extract fields from one or more brands via AI>",
        "body": {
          "fields": [
            { "key": "companyOverview", "description": "A 2-3 sentence neutral summary of what the company does, who it serves, and its main product or service. Written in third person. No marketing language." },
            { "key": "valueProposition", "description": "The single sharpest reason a customer would pick this company over alternatives. One sentence. Outcome-focused (what the customer gets), not feature-focused." },
            { "key": "targetAudience", "description": "The ideal customer profile as an array of strings. Each string is one distinct ICP segment (job title, company size, industry, or use case). Return 1-5 segments." }
          ]
        }
      },
      "inputMapping": { "brandId": "$ref:start-run.output.<path to brandId in start-run response>" }
    },
    {
      "id": "email-generate",
      "type": "http.call",
      "config": { "service": "content-generation", "method": "POST", "path": "<endpoint to generate content>", "body": { "type": "cold-email", "includeAiDisclaimer": true } },
      "inputMapping": {
        "body.brandId": "$ref:start-run.output.<path to brandId in start-run response>",
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.leadId": "$ref:fetch-lead.output.<path to leadId in fetch-lead response>",
        "body.workflowSlug": "$ref:start-run.output.<path to workflowSlug in start-run response>",
        "body.apolloEnrichmentId": "$ref:fetch-lead.output.<path to apollo person/enrichment id in fetch-lead response>",
        "body.variables.leadEmail": "$ref:fetch-lead.output.<path to lead's email>",
        "body.variables.leadFirstName": "$ref:fetch-lead.output.<path to lead's first name>",
        "body.variables.leadLastName": "$ref:fetch-lead.output.<path to lead's last name>",
        "body.variables.leadTitle": "$ref:fetch-lead.output.<path to lead's job title or headline>",
        "body.variables.leadCompanyName": "$ref:fetch-lead.output.<path to lead's company name>",
        "body.variables.leadCompanyDomain": "$ref:fetch-lead.output.<path to lead's company domain>",
        "body.variables.clientBrandUrl": "$ref:start-run.output.<path to brand url in start-run response>",
        "body.variables.clientCompanyOverview": "$ref:brand-extract.output.fields.companyOverview.value",
        "body.variables.clientValueProposition": "$ref:brand-extract.output.fields.valueProposition.value",
        "body.variables.clientTargetAudience": "$ref:brand-extract.output.fields.targetAudience.value"
      },
      "retries": 0
    },
    {
      "id": "email-send",
      "type": "http.call",
      "config": { "service": "email-gateway", "method": "POST", "path": "<endpoint to send a broadcast email>", "body": { "type": "broadcast", "tag": "cold-email" }, "validateResponse": { "field": "success", "equals": true } },
      "inputMapping": {
        "body.to": "$ref:fetch-lead.output.<path to lead's email>",
        "body.subject": "$ref:email-generate.output.<path to generated subject>",
        "body.sequence": "$ref:email-generate.output.<path to generated email sequence array>",
        "body.leadId": "$ref:fetch-lead.output.<path to leadId in fetch-lead response>",
        "body.brandId": "$ref:start-run.output.<path to brandId in start-run response>",
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.workflowSlug": "$ref:start-run.output.<path to workflowSlug in start-run response>",
        "body.recipientFirstName": "$ref:fetch-lead.output.<path to lead's first name>",
        "body.recipientLastName": "$ref:fetch-lead.output.<path to lead's last name>",
        "body.recipientCompany": "$ref:fetch-lead.output.<path to lead's company name>",
        "body.timezone": "$ref:fetch-lead.output.<path to lead's IANA timezone>"
      },
      "retries": 0
    },
    {
      "id": "end-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": true, "stopCampaign": false } }
    },
    {
      "id": "end-run-no-lead",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": true, "stopCampaign": true } }
    },
    {
      "id": "end-run-error",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "<endpoint to end a campaign run>", "body": { "success": false, "stopCampaign": false } }
    }
  ],
  "edges": [
    { "from": "gate-check", "to": "start-run" },
    { "from": "start-run", "to": "fetch-lead" },
    { "from": "fetch-lead", "to": "check-lead" },
    { "from": "check-lead", "to": "brand-extract", "condition": "results.fetch_lead.found == true" },
    { "from": "brand-extract", "to": "email-generate" },
    { "from": "email-generate", "to": "email-send" },
    { "from": "email-send", "to": "end-run" },
    { "from": "check-lead", "to": "end-run-no-lead" }
  ],
  "onError": "end-run-error"
}
\`\`\`

## Example: Simple For-Each Loop

\`\`\`json
{
  "nodes": [
    { "id": "fetch-contacts", "type": "http.call", "config": { "service": "client", "method": "GET", "path": "<endpoint to list contacts/users>" } },
    { "id": "loop-contacts", "type": "for-each", "config": { "iterator": "results.fetch_contacts.<path to array of contacts in fetch-contacts response>", "parallel": false } },
    { "id": "send-email", "type": "http.call", "config": { "service": "transactional-email", "method": "POST", "path": "<endpoint to send a transactional email>" }, "inputMapping": { "body.recipientEmail": "$ref:loop-contacts.output.<path to email field on the iterated contact>" }, "retries": 0 }
  ],
  "edges": [
    { "from": "fetch-contacts", "to": "loop-contacts" },
    { "from": "loop-contacts", "to": "send-email" }
  ]
}
\`\`\`

## Output Format

You MUST respond with a JSON object matching this exact shape:

\`\`\`json
{
  "category": "sales" | "pr",
  "channel": "email",
  "audienceType": "cold-outreach",
  "description": "Human-readable description of what this workflow does (1-2 sentences)",
  "dag": {
    "nodes": [{ "id": "string", "type": "string", "config": {}, "inputMapping": {}, "retries": 0 }],
    "edges": [{ "from": "string", "to": "string", "condition": "optional" }],
    "onError": "optional-node-id"
  }
}
\`\`\`

Generate a single workflow DAG that fulfills the user's description. Return ONLY the JSON object, no explanation.`;
}

export interface BuildUpgradeSystemPromptOptions {
  currentDag: Record<string, unknown>;
  invalidEndpoints: Array<{ service: string; method: string; path: string; reason: string }>;
  fieldErrors?: Array<{ nodeId: string; service: string; method: string; path: string; field: string; reason: string }>;
  serviceContext?: ServiceContext;
}

export function buildUpgradeSystemPrompt(options: BuildUpgradeSystemPromptOptions): string {
  const { currentDag, invalidEndpoints, fieldErrors = [], serviceContext } = options;

  const brokenList = invalidEndpoints
    .map((ep) => `- ${ep.method} ${ep.service}${ep.path} — ${ep.reason}`)
    .join("\n");

  const fieldErrorList = fieldErrors
    .map((f) => `- Node "${f.nodeId}": ${f.reason}`)
    .join("\n");

  const hasBrokenEndpoints = invalidEndpoints.length > 0;
  const hasFieldErrors = fieldErrors.length > 0;

  let issuesSection = "";

  if (hasBrokenEndpoints) {
    issuesSection += `## Broken Endpoints

The following endpoints in this DAG are invalid — they no longer exist in the upstream service:

${brokenList}
`;
  }

  if (hasFieldErrors) {
    issuesSection += `${hasBrokenEndpoints ? "\n" : ""}## Field Errors

The following nodes send incorrect body fields to their endpoints (missing required fields or sending unknown fields):

${fieldErrorList}

To fix field errors, update the node's \`inputMapping\` (add missing \`body.*\` entries or remove incorrect ones) and/or \`config.body\` to match the endpoint's actual request schema. Refer to the service specs below.
`;
  }

  let serviceSpecsSection = "";
  if (serviceContext) {
    serviceSpecsSection = `## Service OpenAPI Specs

Below are the OpenAPI specifications for the relevant services. Use these to find the correct endpoint paths and request body schemas.

\`\`\`json
${JSON.stringify(serviceContext.specs, null, 2)}
\`\`\`
`;
  }

  return `You are a workflow maintenance engineer. Your job is to FIX a broken workflow DAG by correcting endpoint paths and body field mappings.

## Current DAG (DO NOT change business logic)

\`\`\`json
${JSON.stringify(currentDag, null, 2)}
\`\`\`

${issuesSection}
${serviceSpecsSection}
## Your Task

Fix the broken endpoints and field errors using the service specs above, then return the corrected DAG.

## CRITICAL RULES

- **Preserve ALL business logic exactly**: same node IDs, same edges, same conditions, same retries, same onError
- **Only change what's broken**: update config.path, config.body, or inputMapping on the affected nodes
- **Do NOT add, remove, or reorder nodes or edges**
- **Do NOT change conditions, stopAfterIf, skipIf, or any non-broken config keys**
- **Keep the same category, channel, audienceType, and description**
- If you cannot find a replacement endpoint, keep the original and note it in the description
- When fixing field errors, use \`$ref:flow_input.fieldName\` or \`$ref:node-id.output.fieldName\` for dynamic values in inputMapping
- NEVER add cost-tracking nodes — cost tracking is handled internally by each downstream service

## Output Format

You MUST respond with a JSON object matching this exact shape:

\`\`\`json
{
  "category": "sales" | "pr",
  "channel": "email",
  "audienceType": "cold-outreach",
  "description": "Human-readable description",
  "dag": {
    "nodes": [...],
    "edges": [...],
    "onError": "optional-node-id"
  }
}
\`\`\`

Return ONLY the JSON object, no explanation.`;
}

export function buildRetryUserMessage(
  originalDescription: string,
  validationErrors: Array<{ field: string; message: string }>,
): string {
  const errorList = validationErrors
    .map((e) => `- ${e.field}: ${e.message}`)
    .join("\n");

  return `The DAG you generated was invalid. Fix these errors and try again:

${errorList}

Original request: ${originalDescription}`;
}
