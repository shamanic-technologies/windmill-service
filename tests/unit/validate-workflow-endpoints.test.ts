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
                  success: { type: "boolean" },
                  stopCampaign: { type: "boolean" },
                },
                required: ["success", "stopCampaign"],
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
            // stopCampaign missing!
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["campaign", CAMPAIGN_SPEC_WITH_SCHEMAS]]);
    const result = validateWorkflowEndpoints(dag, specs);

    expect(result.valid).toBe(false);
    const errors = result.fieldIssues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.field === "stopCampaign")).toBe(true);
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

describe("field validation — object/array template variables are allowed", () => {
  const CONTENT_GEN_SPEC: Record<string, unknown> = {
    paths: {
      "/generate": {
        post: {
          summary: "Generate content",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    variables: {
                      type: "object",
                      additionalProperties: { nullable: true },
                      description: "Flat variable keys only",
                    },
                    brandId: { type: "string" },
                    campaignId: { type: "string" },
                    leadId: { type: "string" },
                    workflowSlug: { type: "string" },
                  },
                  required: ["type", "variables"],
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
                      subject: { type: "string" },
                      sequence: { type: "array" },
                    },
                    required: ["subject", "sequence"],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const LEAD_SPEC_WITH_SCHEMAS: Record<string, unknown> = {
    paths: {
      "/buffer/next": {
        post: {
          summary: "Get next lead from buffer",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    brandId: { type: "string" },
                    campaignId: { type: "string" },
                  },
                  required: ["campaignId"],
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
                      found: { type: "boolean" },
                      lead: {
                        type: "object",
                        properties: {
                          leadId: { type: "string" },
                          email: { type: "string" },
                          data: {
                            type: "object",
                            properties: {
                              firstName: { type: "string" },
                              lastName: { type: "string" },
                              headline: { type: "string" },
                              organization: {
                                type: "object",
                                properties: {
                                  name: { type: "string" },
                                  primaryDomain: { type: "string" },
                                  industry: { type: "string" },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    required: ["found"],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const BRAND_SPEC: Record<string, unknown> = {
    paths: {
      "/internal/brands/{brandId}": {
        get: {
          summary: "Get a single brand by ID (canonical minimal shape)",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      brand: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          domain: { type: "string" },
                          url: { type: "string" },
                          name: { type: "string" },
                          logoUrl: { type: "string" },
                          createdAt: { type: "string" },
                          updatedAt: { type: "string" },
                        },
                        required: ["id", "domain", "url", "name", "logoUrl", "createdAt", "updatedAt"],
                      },
                    },
                    required: ["brand"],
                  },
                },
              },
            },
          },
        },
      },
      "/orgs/brands/extract-fields": {
        post: {
          summary: "Extract fields from one or more brands via AI",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    fields: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "string" },
                          description: { type: "string" },
                        },
                        required: ["key", "description"],
                      },
                    },
                  },
                  required: ["fields"],
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
                      brands: { type: "array" },
                      fields: { type: "object" },
                    },
                    required: ["brands", "fields"],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("does NOT flag object-valued body.variables.lead (multibrand: objects are valid variable values)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
          },
        },
        {
          id: "brand-profile",
          type: "http.call",
          config: { service: "brand", method: "GET", path: "/internal/brands/{brandId}" },
          inputMapping: {
            "params.brandId": "$ref:flow_input.brandId",
          },
        },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.lead": "$ref:fetch-lead.output.lead",
            "body.variables.brandProfile": "$ref:brand-profile.output",
            "body.variables.targetUrl": "https://example.com",
          },
        },
      ],
      edges: [
        { from: "fetch-lead", to: "email-generate" },
        { from: "brand-profile", to: "email-generate" },
      ],
    };

    const specs = new Map([
      ["content-generation", CONTENT_GEN_SPEC],
      ["lead", LEAD_SPEC_WITH_SCHEMAS],
      ["brand", BRAND_SPEC],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);

    // Object/array-valued template variables are a first-class, intended input
    // (multibrand). content-generation renders objects/arrays as markdown into
    // the prompt — so body.variables.lead mapping to an object is NOT an error
    // and NOT a warning.
    const scalarIssues = result.fieldIssues.filter(
      (i) => i.reason.includes("flat scalars") || i.reason.includes("nested objects"),
    );
    expect(scalarIssues).toHaveLength(0);

    const leadIssues = result.fieldIssues.filter((i) => i.field === "variables.lead");
    expect(leadIssues).toHaveLength(0);
  });

  it("allows flat scalar variables (leadFirstName, leadLastName, etc.)", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next" },
          inputMapping: {
            "body.campaignId": "$ref:flow_input.campaignId",
          },
        },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
            "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
            "body.variables.leadTitle": "$ref:fetch-lead.output.lead.data.headline",
            "body.variables.targetUrl": "https://example.com",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-generate" }],
    };

    const specs = new Map([
      ["content-generation", CONTENT_GEN_SPEC],
      ["lead", LEAD_SPEC_WITH_SCHEMAS],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);

    // No nested object errors
    const nestedErrors = result.fieldIssues.filter(
      (i) => i.reason.includes("flat scalars"),
    );
    expect(nestedErrors).toHaveLength(0);
  });

  it("skips nested object check for flow_input refs", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.targetUrl": "$ref:flow_input.targetUrl",
          },
        },
      ],
      edges: [],
    };

    const specs = new Map([["content-generation", CONTENT_GEN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    const nestedErrors = result.fieldIssues.filter(
      (i) => i.reason.includes("flat scalars"),
    );
    expect(nestedErrors).toHaveLength(0);
  });

  it("detects wrong nested output path lead.firstName instead of lead.data.firstName (regression: recipientFirstName missing)", () => {
    const EMAIL_GATEWAY_SPEC: Record<string, unknown> = {
      paths: {
        "/send": {
          post: {
            summary: "Send email",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      to: { type: "string" },
                      subject: { type: "string" },
                      sequence: { type: "array" },
                      recipientFirstName: { type: "string" },
                      recipientLastName: { type: "string" },
                      recipientCompany: { type: "string" },
                      leadId: { type: "string" },
                      brandId: { type: "string" },
                      campaignId: { type: "string" },
                    },
                    required: ["type", "to", "subject", "recipientFirstName", "recipientLastName", "recipientCompany"],
                  },
                },
              },
            },
          },
        },
      },
    };

    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next" },
          inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
        },
        {
          id: "email-send",
          type: "http.call",
          config: {
            service: "email-gateway",
            method: "POST",
            path: "/send",
            body: { type: "broadcast" },
          },
          inputMapping: {
            "body.to": "$ref:fetch-lead.output.lead.email",
            "body.subject": "$ref:email-gen.output.subject",
            "body.recipientFirstName": "$ref:fetch-lead.output.lead.firstName",
            "body.recipientLastName": "$ref:fetch-lead.output.lead.lastName",
            "body.recipientCompany": "$ref:fetch-lead.output.lead.publicationName",
            "body.leadId": "$ref:fetch-lead.output.lead.leadId",
            "body.campaignId": "$ref:flow_input.campaignId",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-send" }],
    };

    const specs = new Map([
      ["lead", LEAD_SPEC_WITH_SCHEMAS],
      ["email-gateway", EMAIL_GATEWAY_SPEC],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);

    // lead.firstName doesn't exist — correct path is lead.data.firstName
    const deepErrors = result.fieldIssues.filter(
      (i) => i.severity === "error" && i.reason.includes("does not exist under"),
    );
    expect(deepErrors.length).toBeGreaterThanOrEqual(2);

    const fieldPaths = deepErrors.map((e) => e.field);
    expect(fieldPaths).toContain("lead.firstName");
    expect(fieldPaths).toContain("lead.lastName");

    expect(result.valid).toBe(false);
  });

  it("passes deep path validation for correct path lead.data.firstName", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/buffer/next" },
          inputMapping: { "body.campaignId": "$ref:flow_input.campaignId" },
        },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.leadFirstName": "$ref:fetch-lead.output.lead.data.firstName",
            "body.variables.leadLastName": "$ref:fetch-lead.output.lead.data.lastName",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-generate" }],
    };

    const specs = new Map([
      ["lead", LEAD_SPEC_WITH_SCHEMAS],
      ["content-generation", CONTENT_GEN_SPEC],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);

    const deepErrors = result.fieldIssues.filter(
      (i) => i.severity === "error" && i.reason.includes("does not exist under"),
    );
    expect(deepErrors).toHaveLength(0);
  });

  it("accepts array-indexed output paths like results.0.value (regression: regulus false positive)", () => {
    const BRAND_EXTRACT_SPEC: Record<string, unknown> = {
      paths: {
        "/orgs/brands/extract-fields": {
          post: {
            summary: "Extract fields from brand",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      fields: { type: "array" },
                    },
                    required: ["fields"],
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
                        results: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              key: { type: "string" },
                              value: { type: "string" },
                            },
                            required: ["key", "value"],
                          },
                        },
                      },
                      required: ["results"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const dag: DAG = {
      nodes: [
        {
          id: "brand-extract",
          type: "http.call",
          config: { service: "brand", method: "POST", path: "/orgs/brands/extract-fields" },
          inputMapping: {
            "body.fields": "$ref:flow_input.fields",
          },
        },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.industry": "$ref:brand-extract.output.results.0.value",
            "body.variables.geography": "$ref:brand-extract.output.results.1.value",
            "body.variables.audience": "$ref:brand-extract.output.results.2.value",
          },
        },
      ],
      edges: [{ from: "brand-extract", to: "email-generate" }],
    };

    const specs = new Map([
      ["brand", BRAND_EXTRACT_SPEC],
      ["content-generation", CONTENT_GEN_SPEC],
    ]);

    const result = validateWorkflowEndpoints(dag, specs);

    // These should NOT be flagged as errors — array index paths are valid
    const deepErrors = result.fieldIssues.filter(
      (i) => i.severity === "error" && i.reason.includes("does not exist under"),
    );
    expect(deepErrors).toHaveLength(0);
  });

  it("skips nested object check when upstream spec is unavailable", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "unknown-service", method: "POST", path: "/buffer/next" },
        },
        {
          id: "email-generate",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: {
            "body.type": "cold-email",
            "body.variables.lead": "$ref:fetch-lead.output.lead",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-generate" }],
    };

    const specs = new Map([["content-generation", CONTENT_GEN_SPEC]]);
    const result = validateWorkflowEndpoints(dag, specs);

    // Can't validate without upstream spec — no error for this specific check
    const nestedErrors = result.fieldIssues.filter(
      (i) => i.reason.includes("flat scalars"),
    );
    expect(nestedErrors).toHaveLength(0);
  });
});
