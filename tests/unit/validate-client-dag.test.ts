import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";

const mockFetchSpecsForServices = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
}));

const { validateClientDag } = await import("../../src/lib/validate-client-dag.js");

/**
 * Mirrors content-generation POST /generate as deployed: `model` is a
 * version-free alias drawn from a fixed set.
 */
const CONTENT_GEN_SPEC: Record<string, unknown> = {
  paths: {
    "/generate": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  variables: { type: "object", additionalProperties: { nullable: true } },
                  model: {
                    type: "string",
                    enum: [
                      "haiku", "sonnet", "opus",
                      "flash-lite", "flash", "flash-pro", "pro",
                      "deepseek-flash", "deepseek-pro",
                      "glm-flash", "glm-pro",
                      "kimi-flash", "kimi-pro",
                    ],
                  },
                },
                required: ["type", "variables"],
              },
            },
          },
        },
      },
    },
  },
};

const dagWithModel = (model: string): DAG => ({
  nodes: [
    {
      id: "email-generate",
      type: "http.call",
      config: {
        service: "content-generation",
        method: "POST",
        path: "/generate",
        body: { type: "cold-email", variables: {}, model },
      },
    },
  ],
  edges: [],
} as unknown as DAG);

const HEADERS = {} as never;

beforeEach(() => {
  mockFetchSpecsForServices.mockReset();
  mockFetchSpecsForServices.mockResolvedValue(
    new Map([["content-generation", CONTENT_GEN_SPEC]]),
  );
});

describe("validateClientDag", () => {
  it("accepts a DAG whose literal model is in the target schema's enum", async () => {
    expect(await validateClientDag(dagWithModel("deepseek-pro"), HEADERS)).toBeNull();
  });

  it("rejects the alias that reached production on 2026-08-15", async () => {
    const rejection = await validateClientDag(dagWithModel("deepseek-flash-v4"), HEADERS);

    expect(rejection).not.toBeNull();
    expect(rejection!.error).toBe("DAG endpoint validation failed");
    const issues = (rejection!.details as { fieldIssues: Array<{ field: string; reason: string }> })
      .fieldIssues;
    expect(issues.some((i) => i.field === "model" && i.reason.includes("deepseek-flash-v4"))).toBe(true);
  });

  it("reports only errors, never advisory warnings, in the rejection body", async () => {
    const rejection = await validateClientDag(dagWithModel("deepseek-flash-v4"), HEADERS);

    const issues = (rejection!.details as { fieldIssues: Array<{ severity: string }> }).fieldIssues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("rejects a topologically invalid DAG before it ever reaches the registry", async () => {
    const dag = {
      nodes: [],
      edges: [{ from: "nowhere", to: "nothing" }],
    } as unknown as DAG;

    const rejection = await validateClientDag(dag, HEADERS);

    expect(rejection!.error).toBe("Invalid DAG");
    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
  });

  // A spec missing from the map is indistinguishable from a spec whose fetch
  // failed, and `fetchSpecsForServices` settles rather than throws. Reading an
  // absence as "unknown service" would 400 every write during a registry blip.
  it("skips the endpoint check when a spec is absent rather than blocking the write", async () => {
    mockFetchSpecsForServices.mockResolvedValue(new Map());

    expect(await validateClientDag(dagWithModel("deepseek-flash-v4"), HEADERS)).toBeNull();
  });

  it("skips the endpoint check when the registry call throws outright", async () => {
    mockFetchSpecsForServices.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await validateClientDag(dagWithModel("deepseek-flash-v4"), HEADERS)).toBeNull();
  });

  it("does not call the registry for a DAG with no http.call nodes", async () => {
    const dag = {
      nodes: [
        {
          id: "compute",
          type: "script",
          config: { code: "export async function main() { return { ok: true }; }" },
        },
      ],
      edges: [],
    } as unknown as DAG;

    expect(await validateClientDag(dag, HEADERS)).toBeNull();
    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
  });
});
