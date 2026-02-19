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

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const AUTH = { "x-api-key": "test-api-key" };

describe("POST /workflows/:id/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockRunFlow.mockClear();
  });

  it("executes a workflow and returns a run", async () => {
    mockWorkflows.push({
      id: "wf-1",
      orgId: "org-1",
      name: "Test Flow",
      status: "active",
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
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("accepts appId in request body and forwards it to Windmill", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: null,
      orgId: "org-1",
      name: "Test Flow",
      status: "active",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ appId: "kevinlourd-com", inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({ appId: "kevinlourd-com", email: "user@test.com" }),
    );
  });

  it("prefers body appId over workflow appId", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "old-app-id",
      orgId: "org-1",
      name: "Test Flow",
      status: "active",
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/wf-1/execute")
      .set(AUTH)
      .send({ appId: "new-app-id", inputs: {} });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({ appId: "new-app-id" }),
    );
  });

  it("forwards workflow appId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "kevinlourd-com",
      orgId: "org-1",
      name: "Test Flow",
      status: "active",
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
      expect.objectContaining({ appId: "kevinlourd-com", email: "user@test.com" }),
    );
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/wf-1/execute")
      .send({ inputs: {} });

    expect(res.status).toBe(401);
  });
});

describe("POST /workflows/by-name/:name/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockRunFlow.mockClear();
  });

  it("executes a workflow by appId + name", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "newsletter-subscribe",
      status: "active",
      windmillFlowPath: "f/workflows/kevinlourd-com/newsletter_subscribe",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-name/newsletter-subscribe/execute")
      .set(AUTH)
      .send({ appId: "kevinlourd-com", inputs: { email: "test@example.com" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("forwards appId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "create-user-flow",
      status: "active",
      windmillFlowPath: "f/workflows/kevinlourd_com/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-name/create-user-flow/execute")
      .set(AUTH)
      .send({ appId: "kevinlourd-com", inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/kevinlourd_com/create_user_flow",
      expect.objectContaining({ appId: "kevinlourd-com", email: "user@test.com" }),
    );
  });

  it("includes appId in flow inputs even without other inputs", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "simple-flow",
      status: "active",
      windmillFlowPath: "f/workflows/kevinlourd_com/simple_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-name/simple-flow/execute")
      .set(AUTH)
      .send({ appId: "kevinlourd-com" });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/kevinlourd_com/simple_flow",
      expect.objectContaining({ appId: "kevinlourd-com" }),
    );
  });

  it("returns 404 for unknown workflow name", async () => {
    const res = await request
      .post("/workflows/by-name/nonexistent/execute")
      .set(AUTH)
      .send({ appId: "kevinlourd-com" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
  });

  it("requires appId in body", async () => {
    const res = await request
      .post("/workflows/by-name/test-flow/execute")
      .set(AUTH)
      .send({ inputs: {} }); // missing appId

    expect(res.status).toBe(400);
  });

  it("accepts optional orgId for user context", async () => {
    mockWorkflows.push({
      id: "wf-1",
      appId: "kevinlourd-com",
      orgId: "kevinlourd-com",
      name: "newsletter-subscribe",
      status: "active",
      windmillFlowPath: "f/workflows/kevinlourd-com/newsletter_subscribe",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-name/newsletter-subscribe/execute")
      .set(AUTH)
      .send({
        appId: "kevinlourd-com",
        orgId: "user-org-123",
        inputs: { email: "test@example.com" },
      });

    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe("user-org-123");
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/by-name/test-flow/execute")
      .send({ appId: "kevinlourd-com" });

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
    const res = await request.get("/workflow-runs/run-1/debug");
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
