import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB. Same pattern as workflows.test.ts: optional queue overrides .where() responses.
const mockDbRows: Record<string, unknown>[] = [];
const mockSelectResponses: Record<string, unknown>[][] = [];

vi.mock("../../src/db/index.js", () => {
  const mockDb: Record<string, unknown> = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: crypto.randomUUID(),
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
      from: () => {
        const result = Promise.resolve(mockDbRows);
        (result as unknown as { where: (c?: unknown) => Promise<unknown[]> }).where = () =>
          Promise.resolve(
            mockSelectResponses.length > 0 ? mockSelectResponses.shift()! : mockDbRows,
          );
        return result;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          // Apply update by matching on id from the where clause is not feasible without parsing,
          // so we match against the row whose id was last queried — the upgrade flow updates the
          // predecessor (existing) row, which is always the first matching active row in fixtures.
          // For the deprecate step (status='deprecated'), find the row with status='active' from fixtures.
          const target =
            (values.status === "deprecated"
              ? mockDbRows.find((r) => r.status === "active")
              : undefined) ?? mockDbRows[mockDbRows.length - 1];
          if (target) Object.assign(target, values);
          return {
            returning: () => Promise.resolve([{ ...target, ...values }]),
          };
        },
      }),
    }),
  };
  mockDb.transaction = async (
    fn: (tx: Record<string, unknown>) => Promise<void>,
  ): Promise<void> => fn(mockDb);
  return {
    db: mockDb,
    sql: {
      end: () => Promise.resolve(),
    },
  };
});

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

vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn().mockResolvedValue({ requirements: [], providers: [] }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

describe("POST /workflows/create", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
    mockGenerateWorkflow.mockReset();
  });

  it("creates a workflow from a description", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Search leads, generate email, send",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "I want a cold email outreach workflow that finds leads and sends emails",
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeDefined();
    expect(res.body.workflow.action).toBe("created");
    expect(res.body.workflow.featureSlug).toBe("cold-email-outreach");
    expect(res.body.workflow.workflowSlug).toContain("cold-email-outreach-");
    expect(res.body.dag).toEqual(VALID_LINEAR_DAG);
    expect(res.body.generatedDescription).toBe("Search leads, generate email, send");
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "I want a cold email outreach workflow that finds leads and sends emails", hints: undefined },
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
    const inserted = mockDbRows[0] as Record<string, unknown>;
    expect(inserted.creationType).toBe("scratch");
    expect(inserted.createdFromWorkflow).toBeNull();
  });

  it("returns 200 with existing workflow when signature matches", async () => {
    // Pre-populate an existing active workflow with matching signature
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);
    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000111",
      orgId: "org-1",
      featureSlug: "cold-email-outreach",
      signature: sig,
      workflowDynastySignatureName: "obsidian",
      workflowSlug: "cold-email-outreach-obsidian",
      workflowName: "Cold Email Outreach Obsidian",
      workflowDynastySlug: "cold-email-outreach-obsidian",
      workflowDynastyName: "Cold Email Outreach Obsidian",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "Existing description",
      creationType: "scratch",
      createdFromWorkflow: null,
    });

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Regenerated description",
    });

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach workflow finds leads and sends emails",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("existing");
    expect(res.body.workflow.id).toBe("00000000-0000-4000-8000-000000000111");
    // No new row should have been inserted
    expect(mockDbRows).toHaveLength(1);
  });

  it("returns 422 when LLM generates invalid DAG after retries", async () => {
    const { GenerationValidationError } = await import("../../src/lib/workflow-generator.js");
    mockGenerateWorkflow.mockRejectedValueOnce(
      new GenerationValidationError("Generated DAG is invalid after retries", [
        { field: "nodes", message: 'Unknown node type: "bad-type"' },
      ]),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "bad-workflow",
        description: "A workflow that does something impossible with bad types",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid");
    expect(res.body.details).toBeDefined();
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/create")
      .set(IDENTITY)
      .send({
        featureSlug: "test-auth",
        description: "test workflow description here",
      });

    expect(res.status).toBe(401);
  });

  it("validates request body (missing description)", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
  });

  it("validates description minimum length", async () => {
    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({ featureSlug: "test", description: "hi" });

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
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-hints",
        description: "Cold email outreach with lead search",
        hints: { services: ["lead", "email-gateway"] },
      });

    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      { description: "Cold email outreach with lead search", hints: { services: ["lead", "email-gateway"] } },
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("returns 500 with stage='unknown' when LLM throws unexpected error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("Unexpected LLM error"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-error",
        description: "Some workflow description for testing errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected LLM error");
    expect(res.body.stage).toBe("unknown");
  });

  it("returns 500 with stage='llm' when generator throws chat-service error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("chat-service error: POST /complete -> 502 Bad Gateway: upstream unavailable"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-chat-error",
        description: "Some workflow description for testing chat-service errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("chat-service error:");
    expect(res.body.stage).toBe("llm");
  });

  it("returns 500 with stage='registry' when generator throws api-registry error", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("api-registry error: GET /llm-context -> 500 Internal Server Error: db down"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-registry-error",
        description: "Some workflow description for testing api-registry errors",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("api-registry error:");
    expect(res.body.stage).toBe("registry");
  });

  // AC2 — body.style is stripped (Zod), poetic word, no -v suffix.
  it("ignores body.style and produces a poetic single-word signature name", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Cold outreach",
    });

    // Selects: 1) idempotent existence (no match), 2) feature-scoped name set (empty)
    mockSelectResponses.push([], []);

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "cold-email-outreach",
        description: "Cold email outreach in the style of Alex Hormozi",
        style: { type: "human", humanId: "human-123", name: "Hormozi" },
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow.workflowDynastySignatureName).toMatch(/^[a-z]+$/);
    expect(res.body.workflow.workflowDynastySignatureName).not.toContain("-v");
    expect(res.body.workflow.workflowSlug).toMatch(/^cold-email-outreach-[a-z]+$/);
    expect(mockGenerateWorkflow).toHaveBeenCalledWith(
      expect.not.objectContaining({ style: expect.anything() }),
      expect.anything(),
    );
  });

  // AC1 — three creates with different DAGs produce three distinct dictionary words, never *-v{N}.
  it("produces three distinct words across three creates with different DAGs (no -v suffix)", async () => {
    const DAG_A = VALID_LINEAR_DAG;
    const DAG_B = { ...VALID_LINEAR_DAG, edges: [...(VALID_LINEAR_DAG.edges as unknown[]), { from: "x", to: "y" }] };
    const DAG_C = { ...VALID_LINEAR_DAG, edges: [...(VALID_LINEAR_DAG.edges as unknown[]), { from: "y", to: "z" }] };

    const dags = [DAG_A, DAG_B, DAG_C];
    const names: string[] = [];

    for (const dag of dags) {
      mockGenerateWorkflow.mockResolvedValueOnce({
        dag,
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        description: "ok",
      });
      // No idempotent match; feature-scoped name set is the names already taken on this feature.
      const taken = mockDbRows.map((r) => ({ workflowDynastySignatureName: r.workflowDynastySignatureName }));
      mockSelectResponses.push([], taken);

      const res = await request
        .post("/workflows/create")
        .set(AUTH)
        .send({ featureSlug: "ac1-feature", description: "Workflow description for AC1 testing" });
      expect(res.status).toBe(201);
      names.push(res.body.workflow.workflowDynastySignatureName);
    }

    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(name).not.toContain("-v");
    }
  });

  // AC4 — feature-scope burn crosses orgs.
  it("does not reuse a name burned on the same feature by another org", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: { ...VALID_LINEAR_DAG, edges: [{ from: "z1", to: "z2" }] },
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "org-B asks for the same feature",
    });

    // Idempotent existence check (org-B's signature, no match) → empty.
    // Feature-scoped name set: 'obsidian' is already burned by org-A on this feature.
    mockSelectResponses.push([], [{ workflowDynastySignatureName: "obsidian" }]);

    const res = await request
      .post("/workflows/create")
      .set({ ...AUTH, "x-org-id": "org-B" })
      .send({ featureSlug: "shared-feature", description: "Org B requests new workflow on the shared feature" });

    expect(res.status).toBe(201);
    expect(res.body.workflow.workflowDynastySignatureName).not.toBe("obsidian");
  });

  // AC5 — burned for life, even after deprecation.
  it("does not reuse a name that has been deprecated for the same feature (burned for life)", async () => {
    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: { ...VALID_LINEAR_DAG, edges: [{ from: "p1", to: "p2" }] },
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "fresh dag",
    });

    // Idempotent existence: empty. Feature-scoped name set still includes the deprecated 'obsidian' row.
    mockSelectResponses.push([], [{ workflowDynastySignatureName: "obsidian" }]);

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({ featureSlug: "burn-feature", description: "Brand new scratch workflow on a feature with a deprecated burn" });

    expect(res.status).toBe(201);
    expect(res.body.workflow.workflowDynastySignatureName).not.toBe("obsidian");
  });

  it("returns 500 with stage='config' when CHAT_SERVICE_URL is not configured", async () => {
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for LLM calls"),
    );

    const res = await request
      .post("/workflows/create")
      .set(AUTH)
      .send({
        featureSlug: "test-missing-config",
        description: "Some workflow description for testing missing config",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("CHAT_SERVICE_URL");
    expect(res.body.stage).toBe("config");
  });
});

describe("POST /workflows/upgrade", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
    mockGenerateWorkflow.mockReset();
  });

  it("returns 404 when no active workflow matches the slug", async () => {
    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "missing-slug",
        description: "Upgrade something that does not exist at all",
      });

    expect(res.status).toBe(404);
  });

  it("upgrades in-place when LLM returns the same signature", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);

    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000222",
      orgId: "org-1",
      featureSlug: "cold-email-outreach",
      signature: sig,
      workflowDynastySignatureName: "obsidian",
      workflowSlug: "cold-email-outreach-obsidian",
      workflowName: "Cold Email Outreach Obsidian",
      workflowDynastySlug: "cold-email-outreach-obsidian",
      workflowDynastyName: "Cold Email Outreach Obsidian",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "Old description",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/cold_email_outreach_obsidian",
    });

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: VALID_LINEAR_DAG,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "New description for the same DAG",
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "cold-email-outreach-obsidian",
        description: "Upgrade with same DAG produces same signature",
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("updated");
    expect(res.body.workflow.id).toBe("00000000-0000-4000-8000-000000000222");
    expect(res.body.workflow.version).toBe(1);
  });

  // A retired lineage stays retired across an upgrade. Without inheriting the
  // column the new row would default to dynasty-active, silently putting a
  // dynasty someone retired back into rotation.
  it("carries the dynasty status onto the upgraded version", async () => {
    mockDbRows.push({
      id: "00000000-0000-4000-8000-0000000000de",
      orgId: "org-1",
      featureSlug: "feature",
      signature: "old-sig",
      workflowDynastySignatureName: "camellia",
      workflowSlug: "feature-camellia",
      workflowName: "Feature Camellia",
      workflowDynastySlug: "feature-camellia",
      workflowDynastyName: "Feature Camellia",
      version: 1,
      tags: [],
      status: "active",
      workflowDynastyStatus: "deprecated",
      dag: VALID_LINEAR_DAG,
      description: "v1",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/feature_camellia",
    });
    // SELECT #1 dynasty lookup → active row; SELECT #2 signature-conflict → none.
    mockSelectResponses.push([...mockDbRows], []);

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: { ...VALID_LINEAR_DAG, edges: [{ from: "x1", to: "y1" }] },
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Upgraded v2",
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({ workflowDynastySlug: "feature-camellia", description: "Upgrade a dynasty that was retired" });

    expect(res.status).toBe(201);
    expect(res.body.workflow.workflowDynastyStatus).toBe("deprecated");
  });

  // AC6 — upgrade keeps the same workflow_dynasty_signature_name; v2 slug.
  it("preserves the dynasty signature name on upgrade and bumps to -v2", async () => {
    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000ac6",
      orgId: "org-1",
      featureSlug: "feature",
      signature: "old-sig",
      workflowDynastySignatureName: "obsidian",
      workflowSlug: "feature-obsidian",
      workflowName: "Feature Obsidian",
      workflowDynastySlug: "feature-obsidian",
      workflowDynastyName: "Feature Obsidian",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "v1",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/feature_obsidian",
    });
    // SELECT #1 dynasty lookup → active row; SELECT #2 signature-conflict → none.
    mockSelectResponses.push([...mockDbRows], []);

    mockGenerateWorkflow.mockResolvedValueOnce({
      dag: { ...VALID_LINEAR_DAG, edges: [{ from: "x1", to: "y1" }] },
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Upgraded v2",
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({ workflowDynastySlug: "feature-obsidian", description: "Upgrade with a new signature for AC6" });

    expect(res.status).toBe(201);
    expect(res.body.workflow.action).toBe("upgraded");
    expect(res.body.workflow.workflowDynastySignatureName).toBe("obsidian");
    expect(res.body.workflow.workflowSlug).toBe("feature-obsidian-v2");
    expect(res.body.workflow.version).toBe(2);
  });

  function pushActiveWorkflowFixture(): void {
    mockDbRows.push({
      id: "00000000-0000-4000-8000-0000000003e8",
      orgId: "org-1",
      featureSlug: "stage-test-feature",
      signature: "fixture-sig",
      workflowDynastySignatureName: "umber",
      workflowSlug: "stage-test-feature-umber",
      workflowName: "Stage Test Feature Umber",
      workflowDynastySlug: "stage-test-feature-umber",
      workflowDynastyName: "Stage Test Feature Umber",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "fixture",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/stage_test_feature_umber",
    });
  }

  it("returns 500 with stage='llm' when generator throws chat-service error", async () => {
    pushActiveWorkflowFixture();
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("chat-service error: POST /complete -> 502 Bad Gateway: upstream unavailable"),
    );

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "stage-test-feature-umber",
        description: "Upgrade that will fail at the LLM call",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("chat-service error:");
    expect(res.body.stage).toBe("llm");
  });

  it("returns 500 with stage='registry' when generator throws api-registry error", async () => {
    pushActiveWorkflowFixture();
    mockGenerateWorkflow.mockRejectedValueOnce(
      new Error("api-registry error: GET /llm-context -> 500 Internal Server Error: db down"),
    );

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "stage-test-feature-umber",
        description: "Upgrade that will fail at the registry call",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("api-registry error:");
    expect(res.body.stage).toBe("registry");
  });

  it("returns 500 with stage='unknown' when generator throws an unrecognized error", async () => {
    pushActiveWorkflowFixture();
    mockGenerateWorkflow.mockRejectedValueOnce(new Error("kaboom"));

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "stage-test-feature-umber",
        description: "Upgrade that will fail with an unrecognized error",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("kaboom");
    expect(res.body.stage).toBe("unknown");
  });

  // --- Client-supplied DAG path ---

  function pushUpgradeFixture(opts?: {
    category?: string;
    channel?: string;
    audienceType?: string;
  }): { id: string; signature: string } {
    const sig = "sig-fixture-existing";
    const row = {
      id: "00000000-0000-4000-8000-000000000d46",
      orgId: "org-1",
      featureSlug: "client-dag-feature",
      signature: sig,
      workflowDynastySignatureName: "umber",
      workflowSlug: "client-dag-feature-umber",
      workflowName: "Client Dag Feature Umber",
      workflowDynastySlug: "client-dag-feature-umber",
      workflowDynastyName: "Client Dag Feature Umber",
      version: 1,
      tags: ["initial"],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "existing description",
      category: opts?.category ?? "sales",
      channel: opts?.channel ?? "email",
      audienceType: opts?.audienceType ?? "cold-outreach",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/client_dag_feature_umber",
    };
    mockDbRows.push(row);
    // Drive the two SELECTs the new-signature upgrade path performs:
    //   #1 dynasty lookup → the active row; #2 signature-conflict check → none.
    // (The mock .where() ignores predicates, so the conflict check must be fed []
    // explicitly or it would echo the active row and false-409.)
    mockSelectResponses.push([row], []);
    return { id: row.id, signature: sig };
  }

  it("upgrades in-place when client-supplied dag has same signature (no LLM)", async () => {
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const sig = computeDAGSignature(VALID_LINEAR_DAG);

    mockDbRows.push({
      id: "00000000-0000-4000-8000-000000000a01",
      orgId: "org-1",
      featureSlug: "feat-a",
      signature: sig,
      workflowDynastySignatureName: "alabaster",
      workflowSlug: "feat-a-alabaster",
      workflowName: "Feat A Alabaster",
      workflowDynastySlug: "feat-a-alabaster",
      workflowDynastyName: "Feat A Alabaster",
      version: 1,
      tags: [],
      status: "active",
      dag: VALID_LINEAR_DAG,
      description: "existing",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      creationType: "scratch",
      createdFromWorkflow: null,
      windmillFlowPath: "f/workflows/org-1/feat_a_alabaster",
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "feat-a-alabaster",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.action).toBe("updated");
    expect(res.body.workflow.id).toBe("00000000-0000-4000-8000-000000000a01");
    expect(res.body.workflow.version).toBe(1);
    expect(mockGenerateWorkflow).not.toHaveBeenCalled();
  });

  it("creates a new version when client-supplied dag has a different signature (no LLM)", async () => {
    pushUpgradeFixture();
    const NEW_DAG = {
      ...VALID_LINEAR_DAG,
      nodes: [
        { ...((VALID_LINEAR_DAG.nodes as Record<string, unknown>[])[0]), config: { source: "linkedin" } },
        ...(VALID_LINEAR_DAG.nodes as unknown[]).slice(1),
      ],
    };

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "client-dag-feature-umber",
        dag: NEW_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.workflow.action).toBe("upgraded");
    expect(res.body.workflow.workflowDynastySignatureName).toBe("umber");
    expect(res.body.workflow.workflowSlug).toBe("client-dag-feature-umber-v2");
    expect(res.body.workflow.version).toBe(2);
    expect(mockGenerateWorkflow).not.toHaveBeenCalled();

    // Predecessor row must be flipped to status='deprecated' by the transaction.
    const predecessor = mockDbRows.find(
      (r) => r.id === "00000000-0000-4000-8000-000000000d46",
    );
    expect(predecessor?.status).toBe("deprecated");
  });

  it("inherits category/channel/audienceType from existing row when dag supplied", async () => {
    pushUpgradeFixture({
      category: "outlets",
      channel: "database",
      audienceType: "discovery",
    });
    const NEW_DAG = {
      ...VALID_LINEAR_DAG,
      nodes: [
        { ...((VALID_LINEAR_DAG.nodes as Record<string, unknown>[])[0]), config: { source: "twitter" } },
        ...(VALID_LINEAR_DAG.nodes as unknown[]).slice(1),
      ],
    };

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "client-dag-feature-umber",
        dag: NEW_DAG,
      });

    expect(res.status).toBe(201);
    const insertedRow = mockDbRows[mockDbRows.length - 1] as Record<string, unknown>;
    expect(insertedRow.category).toBe("outlets");
    expect(insertedRow.channel).toBe("database");
    expect(insertedRow.audienceType).toBe("discovery");
    expect(insertedRow.creationType).toBe("upgrade");
  });

  it("stores the optional description on the new row when client-supplied dag is provided", async () => {
    pushUpgradeFixture();
    const NEW_DAG = {
      ...VALID_LINEAR_DAG,
      nodes: [
        { ...((VALID_LINEAR_DAG.nodes as Record<string, unknown>[])[0]), config: { source: "google" } },
        ...(VALID_LINEAR_DAG.nodes as unknown[]).slice(1),
      ],
    };

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "client-dag-feature-umber",
        dag: NEW_DAG,
        description: "Surgical fix for the serialize_brand_fields script node",
      });

    expect(res.status).toBe(201);
    const insertedRow = mockDbRows[mockDbRows.length - 1] as Record<string, unknown>;
    expect(insertedRow.description).toBe(
      "Surgical fix for the serialize_brand_fields script node",
    );
    expect(mockGenerateWorkflow).not.toHaveBeenCalled();
  });

  it("rejects the request when neither dag nor description is provided", async () => {
    pushUpgradeFixture();

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "client-dag-feature-umber",
      });

    expect(res.status).toBe(400);
    expect(mockGenerateWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied dag that fails DAG validation", async () => {
    pushUpgradeFixture();
    const INVALID_DAG = { nodes: [], edges: [] };

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "client-dag-feature-umber",
        dag: INVALID_DAG,
      });

    expect(res.status).toBe(400);
    expect(mockGenerateWorkflow).not.toHaveBeenCalled();
  });
});
