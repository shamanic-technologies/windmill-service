import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB state
const mockWorkflows: Record<string, unknown>[] = [];
const mockRuns: Record<string, unknown>[] = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: "run-" + Math.random().toString(36).slice(2, 10),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        mockRuns.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // Simple mock: return first matching item
          if (mockWorkflows.length > 0) return Promise.resolve([mockWorkflows[0]]);
          if (mockRuns.length > 0) return Promise.resolve([mockRuns[0]]);
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const run = mockRuns[mockRuns.length - 1];
          if (run) Object.assign(run, values);
          return {
            returning: () => Promise.resolve([{ ...run, ...values }]),
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
const mockRunFlow = vi.fn().mockResolvedValue("job-uuid-123");
const mockGetJob = vi.fn().mockResolvedValue({
  id: "job-uuid-123",
  running: false,
  success: true,
  result: { output: "done" },
});
const mockCancelJob = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => ({
    createFlow: vi.fn().mockResolvedValue("f/workflows/test/flow"),
    updateFlow: vi.fn().mockResolvedValue(undefined),
    deleteFlow: vi.fn().mockResolvedValue(undefined),
    runFlow: mockRunFlow,
    getJob: mockGetJob,
    cancelJob: mockCancelJob,
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

// Mock runs-service client
const mockCreateRun = vi.fn().mockResolvedValue({ runId: "run-own-123" });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

describe("POST /workflows/:id/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockRunFlow.mockClear();
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-123" });
  });

  it("executes a workflow and returns a run", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Test Flow",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ inputs: { key: "value" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(res.body.runId).toBe("run-own-123");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("creates a child run in runs-service with caller's runId as parentRunId", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Test Flow",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
    });
  });

  it("forwards orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Test Flow",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({ orgId: "org-1", userId: "user-1", runId: "run-own-123", email: "user@test.com" }),
    );
  });

  it("uses x-org-id header (not workflow.orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "deployer-org-different",
      name: "Test Flow",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/wf-1/execute")
      .set(AUTH) // x-org-id: "org-1"
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe("org-1"); // from header, not workflow.orgId
    expect(res.body.userId).toBe("user-1");

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1", // from header
      userId: "user-1",
    });
  });

  it("returns 502 when runs-service fails", async () => {
    mockCreateRun.mockRejectedValueOnce(
      new Error("runs-service error: POST /runs/start -> 500 Internal Server Error: boom")
    );

    mockWorkflows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Test Flow",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("runs-service");
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/wf-1/execute")
      .set(IDENTITY)
      .send({ inputs: {} });

    expect(res.status).toBe(401);
  });
});

describe("POST /workflows/by-name/:name/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockRunFlow.mockClear();
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-456" });
  });

  it("executes a workflow by name (name-only lookup, no org filter)", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "deployer-org",
      name: "newsletter-subscribe",
      windmillFlowPath: "f/workflows/org-1/newsletter_subscribe",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-name/newsletter-subscribe/execute")
      .set(AUTH)
      .send({ inputs: { email: "test@example.com" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(res.body.runId).toBe("run-own-456");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("uses x-org-id header (not body orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "deployer-org",
      name: "create-user-flow",
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-name/create-user-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    // orgId in the run comes from header (org-1), not the deployer org
    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
    });
  });

  it("forwards header orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "deployer-org",
      name: "create-user-flow",
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-name/create-user-flow/execute")
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/create_user_flow",
      expect.objectContaining({ orgId: "org-1", userId: "user-1", runId: "run-own-456", email: "user@test.com" }),
    );
  });

  it("cross-org: workflow deployed by org-A can be executed by org-B", async () => {
    // Workflow deployed by a completely different org
    mockWorkflows.push({
      id: "wf-cross",
      orgId: "8c734aed-45ac-4780-a4ee-1fdcbbedeab1",
      name: "sales-email-cold-outreach-pharaoh",
      windmillFlowPath: "f/workflows/deployer/sales_email_cold_outreach_pharaoh",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    // Execute with a different org in headers
    const CROSS_ORG_AUTH = {
      "x-api-key": "test-api-key",
      "x-org-id": "b645207b-d8e9-40b0-9391-072b777cd9a9",
      "x-user-id": "user-b",
      "x-run-id": "run-caller-b",
    };

    const res = await request
      .post("/workflows/by-name/sales-email-cold-outreach-pharaoh/execute")
      .set(CROSS_ORG_AUTH)
      .send({ inputs: { campaignId: "camp-1" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    // Run is attributed to the executing org, not the deployer
    expect(res.body.orgId).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
    expect(res.body.userId).toBe("user-b");
  });

  it("does not require orgId in body (uses header instead)", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "deployer-org",
      name: "simple-flow",
      windmillFlowPath: "f/workflows/org_1/simple_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-name/simple-flow/execute")
      .set(AUTH)
      .send({ inputs: {} }); // no orgId in body

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("user-1");
    expect(res.body.orgId).toBe("org-1");
  });

  it("returns 404 for unknown workflow name", async () => {
    const res = await request
      .post("/workflows/by-name/nonexistent/execute")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/by-name/test-flow/execute")
      .set(IDENTITY)
      .send({});

    expect(res.status).toBe(401);
  });
});

describe("GET /workflow-runs/:id", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
  });

  it("returns a completed run after polling Windmill", async () => {
    mockRuns.push({
      id: "run-1",
      workflowId: "wf-1",
      orgId: "org-1",
      status: "running",
      windmillJobId: "job-uuid-123",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request.get("/workflow-runs/run-1").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result).toEqual({ output: "done" });
  });
});

describe("GET /workflow-runs/:id/debug", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockGetJob.mockClear();
  });

  it("returns flow_status from Windmill for a completed run", async () => {
    const flowStatus = {
      step: 3,
      modules: [
        { id: "fetch_lead", type: "Success", result: { found: true, lead: { data: { firstName: "Alice" } } } },
        { id: "email_generate", type: "Success", result: { subject: "Hello Alice", bodyHtml: "<p>Hi Alice</p>" } },
        { id: "email_send", type: "Success", result: { success: true } },
      ],
    };
    mockGetJob.mockResolvedValueOnce({
      id: "job-uuid-789",
      running: false,
      success: true,
      result: { status: "completed" },
      flow_status: flowStatus,
    });

    mockRuns.push({
      id: "run-debug-1",
      workflowId: "wf-1",
      orgId: "org-1",
      status: "completed",
      windmillJobId: "job-uuid-789",
      windmillWorkspace: "prod",
      inputs: { campaignId: "camp-1" },
      result: { status: "completed" },
      error: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request
      .get("/workflow-runs/run-debug-1/debug")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe("run-debug-1");
    expect(res.body.windmillJobId).toBe("job-uuid-789");
    expect(res.body.flowStatus).toEqual(flowStatus);
    expect(res.body.flowStatus.modules).toHaveLength(3);
    expect(res.body.flowStatus.modules[0].result.lead.data.firstName).toBe("Alice");
  });

  it("returns 404 for unknown run", async () => {
    const res = await request
      .get("/workflow-runs/nonexistent/debug")
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("returns 400 if run has no windmill job ID", async () => {
    mockRuns.push({
      id: "run-no-job",
      workflowId: "wf-1",
      orgId: "org-1",
      status: "queued",
      windmillJobId: null,
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request
      .get("/workflow-runs/run-no-job/debug")
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no Windmill job ID");
  });

  it("returns null flowStatus when Windmill has no flow_status", async () => {
    mockGetJob.mockResolvedValueOnce({
      id: "job-uuid-simple",
      running: false,
      success: true,
      result: { output: "done" },
    });

    mockRuns.push({
      id: "run-simple",
      workflowId: "wf-1",
      orgId: "org-1",
      status: "completed",
      windmillJobId: "job-uuid-simple",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request
      .get("/workflow-runs/run-simple/debug")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.flowStatus).toBeNull();
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflow-runs/run-1/debug")
      .set(IDENTITY);
    expect(res.status).toBe(401);
  });
});

describe("POST /workflow-runs/:id/cancel", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockCancelJob.mockClear();
  });

  it("cancels a running workflow", async () => {
    mockRuns.push({
      id: "run-1",
      workflowId: "wf-1",
      orgId: "org-1",
      status: "running",
      windmillJobId: "job-uuid-456",
      windmillWorkspace: "prod",
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request
      .post("/workflow-runs/run-1/cancel")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockCancelJob).toHaveBeenCalled();
  });
});
