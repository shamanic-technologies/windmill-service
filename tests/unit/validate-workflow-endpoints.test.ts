import { describe, it, expect } from "vitest";
import {
  validateWorkflowEndpoints,
  extractBodyFields,
  extractOutputRefs,
} from "../../src/lib/validate-workflow-endpoints.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const CAMPAIGN_SPEC: Record<string, unknown> = {
  paths: {
    "/gate-check": { post: { summary: "Gate check" } },
    "/start-run": { post: { summary: "Start run" } },
    "/end-run": { post: { summary: "End run" } },
  },
};

const CAMPAIGN_SPEC_WITH_SCHEMAS: Record<string, unknown> = {
  paths: {
    "/gate-check": {
      post: {
        summary: "Gate check",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  campaignId: { type: "string" },
                  orgId: { type: "string" },
                },
                required: ["campaignId", "orgId"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    allowed: { type: "boolean" },
                    reason: { type: "string" },
                  },
                  required: ["allowed"],
                },
              },
            },
          },
        },
      },
    },
    "/start-run": {
      post: {
        summary: "Start run",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  campaignId: { type: "string" },
                  orgId: { type: "string" },
                },
                required: ["campaignId", "orgId"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    runId: { type: "string" },
                    brandId: { type: "string" },
                    appId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/end-run": {
      post: {
        summary: "End run",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  campaignId: { type: "string" },
                  orgId: { type: "string" },
                  success: { type: "boolean" },
                },
                required: ["campaignId", "orgId", "success"],
              },
            },
          },
        },
      },
    },
  },
};

const LEAD_SPEC: Record<string, unknown> = {
  paths: {
    "/buffer/next": { post: { summary: "Get next lead" } },
  },
};

describe("validateWorkflowEndpoints", () => {
  it("returns valid for a DAG with all correct endpoints", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next" },
        },
      ],
      edges: [{ from: "gate-check", to: "fetch-lead" }],
    };

    const specs = new Map<string, Record<string, unknown>>([
      ["campaign", CAMPAIGN_SPEC],
      ["lead", LEAD_SPEC],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);
    expect(result.valid).toBe(true);
    expect(result.invalidEndpoints).toHaveLength(0);
  });

  it("detects a stale path (e.g., /internal/gate-check)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/internal/gate-check" },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints).toHaveLength(1);
    expect(result.invalidEndpoints[0].path).toBe("/internal/gate-check");
    expect(result.invalidEndpoints[0].reason).toContain("not found");
  });

  it("detects missing service in the registry", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "call-unknown",
          type: "http.call",
          config: { service: "nonexistent", method: "GET", path: "/foo" },
        },
      ],
      edges: [],
    };

    const specs = new Map<string, Record<string, unknown>>();
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints[0].reason).toContain('not found in API Registry');
  });

  it("detects wrong HTTP method", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "GET", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints[0].reason).toContain("Method GET not found");
  });

  it("skips non-http.call nodes", () => {
    const dag: DAG = {
      nodes: [
        { id: "wait-step", type: "wait", config: { seconds: 5 } },
        { id: "branch", type: "condition" },
      ],
      edges: [{ from: "wait-step", to: "branch" }],
    };

    const specs = new Map<string, Record<string, unknown>>();
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(true);
    expect(result.invalidEndpoints).toHaveLength(0);
  });

  it("handles spec with no paths", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "call",
          type: "http.call",
          config: { service: "empty-service", method: "POST", path: "/foo" },
        },
      ],
      edges: [],
    };

    const specs = new Map([["empty-service", { info: { title: "Empty" } }]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints[0].reason).toContain("no paths");
  });

  it("validates multiple broken endpoints in one workflow", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/internal/gate-check" },
        },
        {
          id: "end-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/internal/end-run" },
        },
        {
          id: "start-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/start-run" },
        },
      ],
      edges: [
        { from: "gate-check", to: "start-run" },
        { from: "start-run", to: "end-run" },
      ],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints).toHaveLength(2);
    const brokenPaths = result.invalidEndpoints.map((e) => e.path);
    expect(brokenPaths).toContain("/internal/gate-check");
    expect(brokenPaths).toContain("/internal/end-run");
  });

  it("returns fieldIssues array even when empty", () => {
    const dag: DAG = {
      nodes: [{ id: "wait", type: "wait", config: { seconds: 1 } }],
      edges: [],
    };
    const result = validateWorkflowEndpoints(dag, new Map());
    expect(result.fieldIssues).toEqual([]);
  });
});

describe("field validation — input fields", () => {
  it("detects unknown body field (clerkOrgId vs orgId regression)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    // clerkOrgId is unknown → warning
    const warnings = result.fieldIssues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("clerkOrgId");
    expect(warnings[0].reason).toContain("not in");

    // orgId is required but missing → error
    const errors = result.fieldIssues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("orgId");
    expect(errors[0].reason).toContain("Required");

    expect(result.valid).toBe(false);
  });

  it("passes when all body fields match schema", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            "body.orgId": "$ref:flow_input.orgId",
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(true);
    expect(result.fieldIssues).toHaveLength(0);
  });

  it("detects missing required field from config.body", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "end-run",
          type: "http.call",
          config: {
            service: "campaign",
            method: "POST",
            path: "/end-run",
            body: { success: true },
          },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            // orgId missing!
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    const errors = result.fieldIssues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.field === "orgId")).toBe(true);
  });

  it("extracts body fields from both config.body and inputMapping", () => {
    const node = {
      id: "test",
      type: "http.call" as const,
      config: {
        body: { success: true, tag: "cold-email" },
      },
      inputMapping: {
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.metadata.emailId": "$ref:email-gen.output.id",
      },
    };

    const fields = extractBodyFields(node);
    expect(fields).toContain("success");
    expect(fields).toContain("tag");
    expect(fields).toContain("campaignId");
    expect(fields).toContain("metadata");
    expect(fields).not.toContain("emailId"); // nested under metadata
  });

  it("skips body validation when body is passed as whole object", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "forward",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            body: "$ref:some-node.output",
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    // No field issues because body is opaque
    expect(result.fieldIssues).toHaveLength(0);
  });

  it("skips field validation when no requestBody schema exists", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            "body.anything": "$ref:flow_input.anything",
          },
        },
      ],
      edges: [],
    };

    // Spec without requestBody schema
    const specs = new Map([["campaign", CAMPAIGN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.fieldIssues).toHaveLength(0);
  });
});

describe("field validation — output fields", () => {
  it("detects referenced output field not in response schema", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "start-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/start-run" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            "body.orgId": "$ref:flow_input.orgId",
          },
        },
        {
          id: "next-step",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            "body.campaignId": "$ref:start-run.output.campaignId",
            "body.orgId": "$ref:start-run.output.nonexistentField",
          },
        },
      ],
      edges: [{ from: "start-run", to: "next-step" }],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    const outputWarnings = result.fieldIssues.filter(
      (i) => i.reason.includes("Output field") && i.reason.includes("nonexistentField"),
    );
    expect(outputWarnings).toHaveLength(1);
    expect(outputWarnings[0].severity).toBe("warning");
  });

  it("passes when output fields exist in response schema", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "start-run",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/start-run" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
            "body.orgId": "$ref:flow_input.orgId",
          },
        },
        {
          id: "next-step",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
          inputMapping: {
            "body.campaignId": "$ref:start-run.output.runId",
            "body.orgId": "$ref:start-run.output.brandId",
          },
        },
      ],
      edges: [{ from: "start-run", to: "next-step" }],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    const outputIssues = result.fieldIssues.filter((i) => i.reason.includes("Output field"));
    expect(outputIssues).toHaveLength(0);
  });

  it("handles whole-output reference (no specific field)", () => {
    const refs = extractOutputRefs(
      {
        nodes: [
          { id: "source", type: "http.call" },
          {
            id: "consumer",
            type: "http.call",
            inputMapping: { body: "$ref:source.output" },
          },
        ],
        edges: [],
      },
      "source",
    );

    // Whole output → no specific field to validate
    expect(refs).toHaveLength(0);
  });

  it("extracts output refs with hyphenated node IDs", () => {
    const refs = extractOutputRefs(
      {
        nodes: [
          { id: "start-run", type: "http.call" },
          {
            id: "next",
            type: "http.call",
            inputMapping: {
              "body.id": "$ref:start-run.output.runId",
              "body.brand": "$ref:start-run.output.brandId",
            },
          },
        ],
        edges: [],
      },
      "start-run",
    );

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.field)).toContain("runId");
    expect(refs.map((r) => r.field)).toContain("brandId");
  });
});
