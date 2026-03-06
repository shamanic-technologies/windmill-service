import { describe, it, expect } from "vitest";
import { validateWorkflowEndpoints } from "../../src/lib/validate-workflow-endpoints.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const CAMPAIGN_SPEC: Record<string, unknown> = {
  paths: {
    "/gate-check": { post: { summary: "Gate check" } },
    "/start-run": { post: { summary: "Start run" } },
    "/end-run": { post: { summary: "End run" } },
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
});
