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
