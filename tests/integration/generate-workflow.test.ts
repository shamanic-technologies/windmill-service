import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB (same pattern as workflows.test.ts)
const mockDbRows: Record<string, unknown>[] = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: "wf-" + Math.random().toString(36).slice(2, 10),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockDbRows.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => {
          return Promise.resolve(mockDbRows);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const row = mockDbRows[mockDbRows.length - 1];
          if (row) Object.assign(row, values);
          return {
            returning: () => Promise.resolve([{ ...row, ...values }]),
          };
        },
      }),
    }),
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// Mock Windmill client
vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: vi.fn().mockResolvedValue(undefined),
    getFlow: vi.fn().mockResolvedValue({ path: "f/workflows/test/flow" }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

// Mock the workflow generator
const mockGenerateWorkflow = vi.fn();
vi.mock("../../src/lib/workflow-generator.js", () => {
  class MockGenerationValidationError extends Error {
    validationErrors: unknown[];
    constructor(msg: string, errors: unknown[]) {
      super(msg);
      this.name = "GenerationValidationError";
      this.validationErrors = errors;
    }
  }
  return {
    generateWorkflow: (...args: unknown[]) => mockGenerateWorkflow(...args),
    GenerationValidationError: MockGenerationValidationError,
  };
});

// Mock fetchAnthropicKey from key-service-client
const mockFetchAnthropicKey = vi.fn().mockResolvedValue({ key: "resolved-anthropic-key", keySource: "platform" });
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn().mockResolvedValue({ requirements: [], providers: [] }),
  fetchAnthropicKey: (...args: unknown[]) => mockFetchAnthropicKey(...args),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

describe("POST /workflows/generate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockGenerateWorkflow.mockReset();
    mockFetchAnthropicKey.mockReset();
    mockFetchAnthropicKey.mockResolvedValue({ key: "resolved-anthropic-key", keySource: "platform" });
  });

  it("generates and deploys a workflow from description", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Search leads, generate email, send",
    });

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "I want a cold email outreach workflow that finds leads and sends emails",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow).toBeDefined();
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.category).toBe("sales");
    expect(res.body.workflow.name).toContain("sales-email-cold-outreach");
    expect(res.body.dag).toEqual(VALID_LINEAR_DAG);
    expect(res.body.generatedDescription).toBe("Search leads, generate email, send");
    expect(res.body.category).toBe("sales");
    expect(res.body.channel).toBe("email");
    expect(res.body.audienceType).toBe("cold-outreach");
    expect(mockFetchAnthropicKey).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1", runId: "run-caller-1" });
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "I want a cold email outreach workflow that finds leads and sends emails", hints: undefined, style: undefined },
      "resolved-anthropic-key",
      { orgId: "org-1", userId: "user-1", runId: "run-caller-1" },
    );
  });

  it("returns 422 when LLM generates invalid DAG after retries", async () => {
    const { GenerationValidationError } = await import("../../src/lib/workflow-generator.js");
    mockGenerateWorkflow.mockRejectedValueOnce(
      new GenerationValidationError("Generated DAG is invalid after retries", [
        { field: "nodes", message: 'Unknown node type: "bad-type"' },
      ]),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "A workflow that does something impossible with bad types",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid");
    expect(res.body.details).toBeDefined();
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(IDENTITY)
      .send({
        description: "test workflow description here",
      });

    expect(res.status).toBe(401);
  });

  it("validates request body (missing description)", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
  });

  it("validates description minimum length", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({ description: "hi" });

    expect(res.status).toBe(400);
  });

  it("passes hints through to generator", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Test",
    });

    await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Cold email outreach with lead search",
        hints: { services: ["lead", "email-gateway"] },
      });

    expect(mockFetchAnthropicKey).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1", runId: "run-caller-1" });
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "Cold email outreach with lead search", hints: { services: ["lead", "email-gateway"] }, style: undefined },
      "resolved-anthropic-key",
      { orgId: "org-1", userId: "user-1", runId: "run-caller-1" },
    );
  });

  it("returns 500 when LLM throws unexpected error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("Unexpected LLM error"),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Some workflow description for testing errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected LLM error");
  });

  it("returns 502 when key-service returns an error", async () => {
    mockFetchAnthropicKey.mockRejectedValueOnce(
      new Error("key-service error: GET /keys/anthropic/decrypt -> 404 Not Found: key not configured"),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Some workflow description for testing key-service errors",
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("key-service error:");
  });

  // --- Style tests ---

  it("generates a styled workflow with human type", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Hormozi-style cold outreach",
    });

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Cold email outreach in the style of Alex Hormozi",
        style: { type: "human", humanId: "human-123", name: "Hormozi" },
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.signatureName).toBe("hormozi-v1");
    expect(res.body.workflow.name).toBe("sales-email-cold-outreach-hormozi-v1");
    // Verify style was passed through to generator
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        style: { type: "human", humanId: "human-123", name: "Hormozi" },
      }),
      "resolved-anthropic-key",
      { orgId: "org-1", userId: "user-1", runId: "run-caller-1" },
    );
  });

  it("generates a styled workflow with brand type", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Brand-style cold outreach",
    });

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Cold email outreach in my brand style with good copy",
        style: { type: "brand", brandId: "brand-456", name: "My Brand" },
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.signatureName).toBe("my-brand-v1");
    expect(res.body.workflow.name).toBe("sales-email-cold-outreach-my-brand-v1");
  });

  it("rejects human style without humanId", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Cold email outreach in expert style",
        style: { type: "human", name: "Hormozi" },
      });

    expect(res.status).toBe(400);
  });

  it("rejects brand style without brandId", async () => {
    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Cold email outreach in brand style long description",
        style: { type: "brand", name: "My Brand" },
      });

    expect(res.status).toBe(400);
  });

  it("generates workflow with old naming when no style provided", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Standard cold outreach",
    });

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Standard cold email outreach without any style preference",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.signatureName).not.toContain("-v");
    expect(res.body.workflow.name).toContain("sales-email-cold-outreach-");
    // signatureName should be a random word, not a versioned style name
    expect(res.body.workflow.signatureName).toMatch(/^[a-z]+$/);
  });

  it("returns 502 when KEY_SERVICE_URL is not configured", async () => {
    mockFetchAnthropicKey.mockRejectedValueOnce(
      new Error("KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"),
    );

    const res = await request
      .post("/workflows/generate")
      .set(AUTH)
      .send({
        description: "Some workflow description for testing missing config",
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("KEY_SERVICE_URL");
  });
});
