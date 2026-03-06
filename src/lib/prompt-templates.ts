import { NODE_TYPE_REGISTRY } from "./node-type-registry.js";

/**
 * Claude tool_use schema for structured DAG output.
 * Forces the LLM to return valid JSON matching this shape.
 */
export const DAG_GENERATION_TOOL = {
  name: "create_workflow" as const,
  description: "Create a valid DAG workflow with dimensions based on the user's description",
  input_schema: {
    type: "object" as const,
    properties: {
      category: {
        type: "string" as const,
        enum: ["sales", "pr"],
        description: "Workflow category",
      },
      channel: {
        type: "string" as const,
        enum: ["email"],
        description: "Distribution channel",
      },
      audienceType: {
        type: "string" as const,
        enum: ["cold-outreach"],
        description: "Audience type",
      },
      description: {
        type: "string" as const,
        description: "Human-readable description of what this workflow does (1-2 sentences)",
      },
      dag: {
        type: "object" as const,
        properties: {
          nodes: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                id: { type: "string" as const },
                type: { type: "string" as const },
                config: { type: "object" as const },
                inputMapping: { type: "object" as const },
                retries: { type: "number" as const },
              },
              required: ["id", "type"],
            },
          },
          edges: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                from: { type: "string" as const },
                to: { type: "string" as const },
                condition: { type: "string" as const },
              },
              required: ["from", "to"],
            },
          },
          onError: { type: "string" as const },
        },
        required: ["nodes", "edges"],
      },
    },
    required: ["category", "channel", "audienceType", "description", "dag"],
  },
};

/** Tool for listing all available services from the API registry */
export const LIST_SERVICES_TOOL = {
  name: "list_services" as const,
  description:
    "List all available microservices in the platform. Returns service name, description, and endpoint summaries. " +
    "Call this FIRST to understand what services are available before designing the workflow.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

/** Tool for getting detailed OpenAPI spec for a specific service */
export const GET_SERVICE_ENDPOINTS_TOOL = {
  name: "get_service_endpoints" as const,
  description:
    "Get the full OpenAPI specification for a specific service, including all endpoints, " +
    "request/response schemas, required fields, and parameter details. " +
    "Call this for EACH service you plan to use in the workflow to understand exact endpoint paths, " +
    "required body fields, and response shapes. Do NOT guess — always verify.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string" as const,
        description: "The service name (e.g. 'lead', 'campaign', 'brand')",
      },
    },
    required: ["service"],
  },
};

/** All tools for agentic workflow generation */
export const AGENTIC_TOOLS = [
  LIST_SERVICES_TOOL,
  GET_SERVICE_ENDPOINTS_TOOL,
  DAG_GENERATION_TOOL,
];

export interface BuildSystemPromptOptions {
  styleDirective?: string;
}

export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  const { styleDirective } = options ?? {};

  const nodeTypes = Object.entries(NODE_TYPE_REGISTRY)
    .map(([type, path]) => {
      if (path === null) return `- "${type}" (native flow control)`;
      return `- "${type}"`;
    })
    .join("\n");

  const serviceSection = `## Service Discovery (MANDATORY)

You have access to a live API registry via tools. Before generating the workflow, you MUST:
1. Call list_services to see all available microservices and their endpoints
2. Call get_service_endpoints for EACH service you plan to use in the workflow — this gives you exact endpoint paths, required request body fields, and response schemas
3. Only then call create_workflow with an informed DAG based on verified endpoint specs

Do NOT guess endpoint paths or request body fields. ALWAYS verify with get_service_endpoints first.
If a service or endpoint you need does not exist, do NOT invent it — adjust the workflow to use only real endpoints.`;

  return `You are a workflow architect that generates valid DAG (Directed Acyclic Graph) workflows.

## DAG Format

A workflow DAG has:
- **nodes**: Array of steps. Each node: { id (string, kebab-case), type (string), config? (object), inputMapping? (object), retries? (number) }
- **edges**: Array of { from, to, condition? } defining execution order.
- **onError**: Optional node ID that runs when any step fails.

## Recommended Node Type: http.call

Use "http.call" for all service calls. Config:
- service (string): service name, maps to {SERVICE}_SERVICE_URL env var
- method (string): HTTP verb (GET, POST, PUT, DELETE)
- path (string): endpoint path
- body (object, optional): static request body parts
- query (object, optional): query params

Example:
{
  "id": "fetch-lead",
  "type": "http.call",
  "config": { "service": "lead", "method": "POST", "path": "/buffer/next" },
  "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId" },
  "retries": 0
}

## Flow Control Node Types

- "condition": if/then/else branching. Outgoing edges WITH a condition expression define branches (target nodes are nested inside that branch). Outgoing edges WITHOUT condition are after-branch steps that always execute after the branchone completes.
- "wait": delay. config: { seconds: number }
- "for-each": loop over items. config: { iterator: string (JS expression), parallel?: boolean, skipFailures?: boolean }

## Input Mapping ($ref syntax)

Use inputMapping to pass dynamic data between nodes:
- "$ref:flow_input.fieldName" — from workflow execution inputs
- "$ref:node-id.output.fieldName" — from a previous node's output
- "$ref:node-id.output" — entire output of a previous node

Dot-notation keys create nested objects:
- "body.campaignId": "$ref:flow_input.campaignId" → body: { campaignId: ... }
- "body.metadata.source": "$ref:flow_input.source" → body: { metadata: { source: ... } }

Static body fields go in config.body, dynamic overrides go in inputMapping with dot-notation.

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

## Campaign Execution Model

Campaign service orchestrates workflow execution with budget constraints. Key concepts:
- A campaign has budget limits: max leads and/or max spend, scoped per day, per week, or per month
- Campaign service triggers the workflow (DAG) repeatedly, roughly every minute, until the budget is exhausted
- Each workflow run processes ONE unit of work (e.g. one lead, one email send)
- The gate-check step validates that budget remains before each run — if budget is exhausted, it returns allowed=false and the flow stops gracefully via stopAfterIf
- The end-run step reports success/failure so campaign service knows whether to continue re-triggering
- This is why campaign workflows MUST use the chassis pattern: gate-check → start-run → [business logic] → end-run, with onError → end-run-error

## Rules

1. Node IDs: unique, kebab-case, descriptive (e.g. "fetch-lead", "send-email", "check-status")
2. No cycles — edges must form a DAG
3. Every $ref must reference an existing node ID or flow_input
4. Set retries: 0 for non-idempotent operations (email sends, SMS, queue consumes)
5. Use onError for workflows that need cleanup on failure (e.g. mark run as failed via end-run)
6. Use "condition" nodes for branching, not skipIf (skipIf only skips one step)
7. The http.call node auto-injects orgId, userId, and serviceEnvs from flow_input — no need to map them
8. Campaign workflows should use the chassis pattern: gate-check → start-run → ... → end-run, with onError → end-run-error

## Example: Cold Email Outreach with Branching

\`\`\`json
{
  "nodes": [
    {
      "id": "gate-check",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "/gate-check", "stopAfterIf": "result.allowed == false" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "start-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "/start-run" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:flow_input.orgId" }
    },
    {
      "id": "fetch-lead",
      "type": "http.call",
      "config": { "service": "lead", "method": "POST", "path": "/buffer/next" },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.orgId": "$ref:start-run.output.orgId" },
      "retries": 0
    },
    { "id": "check-lead", "type": "condition" },
    {
      "id": "brand-profile",
      "type": "http.call",
      "config": { "service": "brand", "method": "POST", "path": "/sales-profile" },
      "inputMapping": { "body.brandId": "$ref:start-run.output.brandId" }
    },
    {
      "id": "email-generate",
      "type": "http.call",
      "config": { "service": "content-generation", "method": "POST", "path": "/generate" },
      "inputMapping": { "body.lead": "$ref:fetch-lead.output.lead", "body.brandProfile": "$ref:brand-profile.output" },
      "retries": 0
    },
    {
      "id": "email-send",
      "type": "http.call",
      "config": { "service": "email-gateway", "method": "POST", "path": "/send" },
      "inputMapping": { "body.to": "$ref:fetch-lead.output.lead.data.email", "body.subject": "$ref:email-generate.output.subject", "body.bodyHtml": "$ref:email-generate.output.bodyHtml" },
      "retries": 0
    },
    {
      "id": "end-run",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "/end-run", "body": { "success": true } },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId", "body.leadFound": "$ref:fetch-lead.output.found" }
    },
    {
      "id": "end-run-error",
      "type": "http.call",
      "config": { "service": "campaign", "method": "POST", "path": "/end-run", "body": { "success": false } },
      "inputMapping": { "body.campaignId": "$ref:flow_input.campaignId" }
    }
  ],
  "edges": [
    { "from": "gate-check", "to": "start-run" },
    { "from": "start-run", "to": "fetch-lead" },
    { "from": "fetch-lead", "to": "check-lead" },
    { "from": "check-lead", "to": "brand-profile", "condition": "results.fetch_lead.found == true" },
    { "from": "brand-profile", "to": "email-generate" },
    { "from": "email-generate", "to": "email-send" },
    { "from": "check-lead", "to": "end-run" }
  ],
  "onError": "end-run-error"
}
\`\`\`

## Example: Simple For-Each Loop

\`\`\`json
{
  "nodes": [
    { "id": "fetch-contacts", "type": "http.call", "config": { "service": "client", "method": "GET", "path": "/users" } },
    { "id": "loop-contacts", "type": "for-each", "config": { "iterator": "results.fetch_contacts.users", "parallel": false } },
    { "id": "send-email", "type": "http.call", "config": { "service": "transactional-email", "method": "POST", "path": "/send" }, "inputMapping": { "body.recipientEmail": "$ref:loop-contacts.output.email" }, "retries": 0 }
  ],
  "edges": [
    { "from": "fetch-contacts", "to": "loop-contacts" },
    { "from": "loop-contacts", "to": "send-email" }
  ]
}
\`\`\`

${styleDirective ? `## Style Directive\n\n${styleDirective}\n\n` : ""}Generate a single workflow DAG that fulfills the user's description. Use the create_workflow tool to return the result.`;
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
