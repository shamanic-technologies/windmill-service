import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Windmill Service",
    description: [
      "Workflow orchestration service. Register DAG workflows once, execute them by name with runtime inputs.",
      "",
      "## Quick Start",
      "",
      "**Step 1 — Deploy your workflows (once, at app startup):**",
      "```",
      "PUT /workflows/deploy",
      '{ "appId": "my-app", "workflows": [{ "name": "my-flow", "dag": { ... } }] }',
      "```",
      "This is idempotent — safe to call on every cold start.",
      "",
      "**Step 2 — Execute by name (each time an event occurs):**",
      "```",
      "POST /workflows/by-name/my-flow/execute",
      '{ "appId": "my-app", "inputs": { "email": "user@example.com" } }',
      "```",
      "Returns a run ID. Poll `GET /workflow-runs/{id}` for status and result.",
      "",
      "## DAG Format",
      "",
      "A DAG has `nodes` (steps) and `edges` (execution order).",
      "",
      "**Recommended node type: `http.call`** — calls any microservice by name:",
      "```json",
      '{',
      '  "id": "create-user",',
      '  "type": "http.call",',
      '  "config": { "service": "client", "method": "POST", "path": "/users" },',
      '  "inputMapping": { "body": "$ref:flow_input.userData" }',
      '}',
      "```",
      "The service name maps to env vars `{NAME}_SERVICE_URL` and `{NAME}_SERVICE_API_KEY`.",
      "To discover available services and their endpoints, use the API Registry.",
      "",
      "## Input Mapping ($ref syntax)",
      "",
      "Use `inputMapping` to pass data between nodes:",
      "- `$ref:flow_input.field` — from the workflow execution inputs",
      "- `$ref:node-id.output.field` — from a previous node's output",
      "",
      "## Features",
      "",
      "- Automatic retries (3 attempts, 5s apart) on each node",
      "- Async execution with status polling",
      "- Topological ordering — nodes run in dependency order",
      "- Native constructs: `wait` (delay), `condition` (branching), `for-each` (loops)",
    ].join("\n"),
    version: "1.0.0",
  },
  servers: [
    {
      url: process.env.SERVICE_URL ?? "https://windmill.mcpfactory.org",
    },
  ],
});

writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
