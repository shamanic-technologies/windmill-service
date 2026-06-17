import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock DB state
const mockWorkflows: Record<string, unknown>[] = [];
const mockRuns: Record<string, unknown>[] = [];
// Optional queue: when populated, select().from().where() shifts from it
const mockSelectResponses: Record<string, unknown>[][] = [];

// Helper: creates a thenable query result that also supports .limit()
function mockQueryResult(data: Record<string, unknown>[]) {
  const obj = {
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(data).then(resolve, reject),
    limit: () => obj,
  };
  return obj;
}

function isWorkflowRunsTable(table: unknown): boolean {
  return !!table && typeof table === "object" && "windmillJobId" in table;
}

const ACTIVE_RUN_STATUSES = new Set(["dispatching", "queued", "running"]);

function extractParamForColumn(condition: unknown, columnName: string): unknown {
  if (!condition || typeof condition !== "object") return undefined;
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk && typeof chunk === "object") {
        const name = (chunk as { name?: unknown }).name;
        if (name === columnName) {
          const next = chunks[i + 2];
          if (next && typeof next === "object" && "value" in next) {
            return (next as { value: unknown }).value;
          }
        }
        const nested = extractParamForColumn(chunk, columnName);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

vi.mock("../../src/db/index.js", () => {
  type MockDb = {
    execute: ReturnType<typeof vi.fn>;
    transaction: (fn: (tx: MockDb) => Promise<void>) => Promise<void>;
    insert: (table: unknown) => {
      values: (row: Record<string, unknown>) => {
        returning: () => Promise<Record<string, unknown>[]>;
      };
    };
    select: () => {
      from: (table: unknown) => {
        where: () => ReturnType<typeof mockQueryResult>;
      };
    };
    update: (table: unknown) => {
      set: (values: Record<string, unknown>) => {
        where: () => {
          returning: () => Promise<Record<string, unknown>[]>;
        };
      };
    };
  };

  const mockDb: MockDb = {
    execute: vi.fn().mockResolvedValue(undefined),
    transaction: async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const newRow = {
          id: crypto.randomUUID(),
          ...row,
          windmillWorkspace: row.windmillWorkspace ?? "prod",
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        if (isWorkflowRunsTable(table)) {
          mockRuns.push(newRow);
        } else {
          mockWorkflows.push(newRow);
        }
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition?: unknown) => {
          if (mockSelectResponses.length > 0) {
            return mockQueryResult(mockSelectResponses.shift()!);
          }
          if (isWorkflowRunsTable(table)) {
            const executionKey = extractParamForColumn(condition, "execution_key");
            if (typeof executionKey === "string") {
              return mockQueryResult(
                mockRuns.filter((run) =>
                  run.executionKey === executionKey &&
                  ACTIVE_RUN_STATUSES.has(String(run.status))
                ),
              );
            }
            return mockQueryResult(mockRuns.length > 0 ? [mockRuns[0]] : []);
          }
          if (mockWorkflows.length > 0) return mockQueryResult([mockWorkflows[0]]);
          return mockQueryResult([]);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (values.error === "Dispatch reservation expired before Windmill job id was recorded") {
            return {
              returning: () => Promise.resolve([]),
            };
          }
          const rows = isWorkflowRunsTable(table) ? mockRuns : mockWorkflows;
          const run = rows[rows.length - 1];
          if (run) Object.assign(run, values);
          return {
            returning: () => Promise.resolve([{ ...run, ...values }]),
          };
        },
      }),
    }),
  };

  return {
    db: mockDb,
    sql: {
      end: () => Promise.resolve(),
    },
  };
});

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
  isAmbiguousWindmillDispatchError: () => false,
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
const mockCloseRun = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
}));

// Mock features-client
vi.mock("../../src/lib/features-client.js", () => ({}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = {
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-caller-1",
  "x-brand-id": "brand-1",
  "x-campaign-id": "camp-1",
  "x-workflow-slug": "test-workflow",
  "x-feature-slug": "test-feature",
};
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

// Valid UUID test IDs
const WF_ID = "00000000-0000-4000-8000-000000000001";
const WF_OLD_ID = "00000000-0000-4000-8000-000000000002";
const WF_NEW_ID = "00000000-0000-4000-8000-000000000003";
const WF_CROSS_ID = "00000000-0000-4000-8000-000000000004";
const WF_V1_ID = "00000000-0000-4000-8000-000000000005";
const WF_V2_ID = "00000000-0000-4000-8000-000000000006";
const WF_V3_ID = "00000000-0000-4000-8000-000000000007";
const WF_DEAD_ID = "00000000-0000-4000-8000-000000000008";
const WF_MISSING_ID = "00000000-0000-4000-8000-000000000009";
const WF_FEAT_ID = "00000000-0000-4000-8000-00000000000a";
const RUN_1_ID = "00000000-0000-4000-8000-000000000010";
const RUN_DEBUG_ID = "00000000-0000-4000-8000-000000000011";
const RUN_NO_JOB_ID = "00000000-0000-4000-8000-000000000012";
const RUN_SIMPLE_ID = "00000000-0000-4000-8000-000000000013";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("Timed out waiting for test condition");
}

describe("POST /workflows/:id/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockReset();
    mockRunFlow.mockResolvedValue("job-uuid-123");
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-123" });
    mockCloseRun.mockClear();
    mockCloseRun.mockResolvedValue(undefined);
  });

  it("executes a workflow and returns a run", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
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
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "test-flow",
      campaignId: "camp-1",
      brandIdHeader: "brand-1",
    });
  });

  it("forwards orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({ orgId: "org-1", userId: "user-1", runId: "run-own-123", email: "user@test.com" }),
    );
  });

  it("preserves tagged campaign attribution through run creation and Windmill inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const attributionContext = {
      goal: "signup",
      brandProfileId: "brand-profile-real-1",
      customerPersonaId: "customer-persona-real-1",
      customerProfileId: "customer-profile-real-1",
      profileId: "profile-real-1",
      personaId: "persona-real-1",
      goalId: "goal-real-1",
      goalSlug: "signups",
      optimizationGoal: "signups",
      source: { service: "campaign-service" },
    };
    const expectedAttribution = {
      ...attributionContext,
      campaignId: "camp-1",
      featureSlug: "test-feature",
      brandIds: ["brand-1"],
      brandId: "brand-1",
    };

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ attributionContext, inputs: { email: "user@test.com" } });

    expect(res.status).toBe(201);
    expect(res.body.attributionContext).toEqual(expectedAttribution);
    expect(mockRuns[0].attributionContext).toEqual(expectedAttribution);
    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({
      attributionContext: expectedAttribution,
    }));
    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/test_flow",
      expect.objectContaining({
        attributionContext: expectedAttribution,
        goal: "signup",
        brandProfileId: "brand-profile-real-1",
        customerPersonaId: "customer-persona-real-1",
        customerProfileId: "customer-profile-real-1",
        profileId: "profile-real-1",
        personaId: "persona-real-1",
        goalId: "goal-real-1",
        goalSlug: "signups",
        optimizationGoal: "signups",
      }),
    );
  });

  it("leaves untagged executions untagged", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: { email: "user@test.com" } });

    expect(res.status).toBe(201);
    expect(res.body.attributionContext).toBeNull();
    expect(mockRuns[0].attributionContext).toBeNull();
    expect(mockCreateRun.mock.calls[0][0]).not.toHaveProperty("attributionContext");
    const flowInputs = mockRunFlow.mock.calls[0][1];
    expect(flowInputs).not.toHaveProperty("attributionContext");
    expect(flowInputs).not.toHaveProperty("goal");
    expect(flowInputs).not.toHaveProperty("brandProfileId");
    expect(flowInputs).not.toHaveProperty("customerPersonaId");
    expect(flowInputs).not.toHaveProperty("customerProfileId");
    expect(flowInputs).not.toHaveProperty("profileId");
    expect(flowInputs).not.toHaveProperty("personaId");
    expect(flowInputs).not.toHaveProperty("goalId");
    expect(flowInputs).not.toHaveProperty("goalSlug");
    expect(flowInputs).not.toHaveProperty("optimizationGoal");
  });

  it("uses x-org-id header (not workflow.orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org-different",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH) // x-org-id: "org-1"
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe("org-1"); // from header, not workflow.orgId
    expect(res.body.userId).toBe("user-1");

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1", // from header
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "test-flow",
      campaignId: "camp-1",
      brandIdHeader: "brand-1",
    });
  });

  it("returns 502 when runs-service fails", async () => {
    mockCreateRun.mockRejectedValueOnce(
      new Error("runs-service error: POST /runs/start -> 500 Internal Server Error: boom")
    );

    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("runs-service");
  });

  it("returns 410 when workflow is deprecated (by ID)", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated
        id: WF_OLD_ID,
        status: "deprecated",
      }],
      [{ id: WF_NEW_ID }], // 3. successor lookup via created_from_workflow
    );

    const res = await request
      .post(`/workflows/${WF_OLD_ID}/execute`)
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBe(WF_NEW_ID);
  });

  it("uses campaignId from header, not from workflow record or inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "test-flow",
      workflowName: "Test Flow",
      workflowDynastySlug: "test-flow",
      workflowDynastyName: "Test Flow",
      version: 1,
      campaignId: "camp-from-wf",
      subrequestId: null,
      windmillFlowPath: "f/workflows/org_1/test_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(AUTH) // x-campaign-id: "camp-1"
      .send({ inputs: { campaignId: "camp-from-input" } });

    expect(res.status).toBe(201);
    expect(res.body.campaignId).toBe("camp-1"); // from header, not input or workflow record
  });

  it("returns 400 when required execution headers are missing", async () => {
    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set({ "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" })
      .send({ inputs: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
    expect(res.body.error).toContain("x-campaign-id");
    expect(res.body.error).toContain("x-brand-id");
  });

  it("requires authentication", async () => {
    const res = await request
      .post(`/workflows/${WF_ID}/execute`)
      .set(IDENTITY)
      .send({ inputs: {} });

    expect(res.status).toBe(401);
  });
});

describe("POST /workflows/by-slug/:slug/execute", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockReset();
    mockRunFlow.mockResolvedValue("job-uuid-123");
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-own-456" });
    mockCloseRun.mockClear();
    mockCloseRun.mockResolvedValue(undefined);
  });

  it("executes a workflow by slug (slug-only lookup, no org filter)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "newsletter-subscribe",
      workflowName: "Newsletter Subscribe",
      workflowDynastySlug: "newsletter-subscribe",
      workflowDynastyName: "Newsletter Subscribe",
      version: 1,
      windmillFlowPath: "f/workflows/org-1/newsletter_subscribe",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-slug/newsletter-subscribe/execute")
      .set(AUTH)
      .send({ inputs: { email: "test@example.com" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.windmillJobId).toBe("job-uuid-123");
    expect(res.body.runId).toBe("run-own-456");
    expect(mockRunFlow).toHaveBeenCalled();
  });

  it("returns the existing active campaign execution for concurrent same org + campaign calls", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "campaign-lock-flow",
      workflowName: "Campaign Lock Flow",
      workflowDynastySlug: "campaign-lock-flow",
      workflowDynastyName: "Campaign Lock Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/campaign_lock_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    let resolveRunFlow: (jobId: string) => void = () => {};
    mockRunFlow.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        resolveRunFlow = resolve;
      }),
    );

    const first = request
      .post("/workflows/by-slug/campaign-lock-flow/execute")
      .set(AUTH)
      .send({ inputs: {} })
      .then((res) => res);

    await waitUntil(() => mockRunFlow.mock.calls.length === 1);

    const second = await request
      .post("/workflows/by-slug/campaign-lock-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(mockRuns[0].id);
    expect(second.body.status).toBe("dispatching");
    expect(mockRunFlow).toHaveBeenCalledTimes(1);

    resolveRunFlow("job-uuid-locked");
    const firstRes = await first;
    expect(firstRes.status).toBe(201);
    expect(firstRes.body.windmillJobId).toBe("job-uuid-locked");
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for concurrent same org + campaign calls when conflictPolicy is reject", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "campaign-reject-flow",
      workflowName: "Campaign Reject Flow",
      workflowDynastySlug: "campaign-reject-flow",
      workflowDynastyName: "Campaign Reject Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/campaign_reject_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    let resolveRunFlow: (jobId: string) => void = () => {};
    mockRunFlow.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        resolveRunFlow = resolve;
      }),
    );

    const first = request
      .post("/workflows/by-slug/campaign-reject-flow/execute")
      .set(AUTH)
      .send({ inputs: {} })
      .then((res) => res);

    await waitUntil(() => mockRunFlow.mock.calls.length === 1);

    const second = await request
      .post("/workflows/by-slug/campaign-reject-flow/execute")
      .set(AUTH)
      .send({ conflictPolicy: "reject", inputs: {} });

    expect(second.status).toBe(409);
    expect(second.body.error).toContain("Active workflow execution");
    expect(second.body.workflowRun.id).toBe(mockRuns[0].id);
    expect(mockRunFlow).toHaveBeenCalledTimes(1);

    resolveRunFlow("job-uuid-reject");
    await first;
  });

  it("allows concurrent executions for different campaigns in the same org", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "multi-campaign-flow",
      workflowName: "Multi Campaign Flow",
      workflowDynastySlug: "multi-campaign-flow",
      workflowDynastyName: "Multi Campaign Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/multi_campaign_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const first = await request
      .post("/workflows/by-slug/multi-campaign-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });
    const second = await request
      .post("/workflows/by-slug/multi-campaign-flow/execute")
      .set({ ...AUTH, "x-campaign-id": "camp-2" })
      .send({ inputs: {} });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockRunFlow).toHaveBeenCalledTimes(2);
  });

  it("allows concurrent executions for the same campaign in different orgs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "multi-org-flow",
      workflowName: "Multi Org Flow",
      workflowDynastySlug: "multi-org-flow",
      workflowDynastyName: "Multi Org Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/multi_org_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const first = await request
      .post("/workflows/by-slug/multi-org-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });
    const second = await request
      .post("/workflows/by-slug/multi-org-flow/execute")
      .set({ ...AUTH, "x-org-id": "org-2" })
      .send({ inputs: {} });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockRunFlow).toHaveBeenCalledTimes(2);
  });

  it("allows a new execution after the previous campaign execution completed", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "completed-campaign-flow",
      workflowName: "Completed Campaign Flow",
      workflowDynastySlug: "completed-campaign-flow",
      workflowDynastyName: "Completed Campaign Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/completed_campaign_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });
    mockRuns.push({
      id: RUN_SIMPLE_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      campaignId: "camp-1",
      workflowSlug: "completed-campaign-flow",
      status: "completed",
      executionScope: "campaign",
      executionKey: "campaign:org-1:camp-1",
      createdAt: new Date(),
    });

    const res = await request
      .post("/workflows/by-slug/completed-campaign-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
  });

  it("marks non-ambiguous Windmill dispatch failures failed so the reservation is released", async () => {
    mockRunFlow.mockRejectedValueOnce(new Error("Windmill API error: 500"));
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "dispatch-fails-flow",
      workflowName: "Dispatch Fails Flow",
      workflowDynastySlug: "dispatch-fails-flow",
      workflowDynastyName: "Dispatch Fails Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/dispatch_fails_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-slug/dispatch-fails-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(502);
    expect(res.body.dispatchState).toBe("not_dispatched");
    expect(mockRuns[0].status).toBe("failed");
    expect(mockRuns[0].completedAt).toBeInstanceOf(Date);
    expect(mockCloseRun).toHaveBeenCalledWith("run-own-456", "failed", "org-1");
  });

  it("uses x-org-id header (not body orgId) for run attribution", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "create-user-flow",
      workflowName: "Create User Flow",
      workflowDynastySlug: "create-user-flow",
      workflowDynastyName: "Create User Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/create-user-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    // orgId in the run comes from header (org-1), not the deployer org
    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: "run-caller-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowSlug: "create-user-flow",
      campaignId: "camp-1",
      brandIdHeader: "brand-1",
    });
  });

  it("forwards header orgId, userId, and own runId into Windmill flow inputs", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "create-user-flow",
      workflowName: "Create User Flow",
      workflowDynastySlug: "create-user-flow",
      workflowDynastyName: "Create User Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/create_user_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/create-user-flow/execute")
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
      id: WF_CROSS_ID,
      orgId: "8c734aed-45ac-4780-a4ee-1fdcbbedeab1",
      workflowSlug: "sales-email-cold-outreach-pharaoh",
      workflowName: "Sales Email Cold Outreach Pharaoh",
      workflowDynastySlug: "sales-email-cold-outreach-pharaoh",
      workflowDynastyName: "Sales Email Cold Outreach Pharaoh",
      version: 1,
      windmillFlowPath: "f/workflows/upgradeer/sales_email_cold_outreach_pharaoh",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    // Execute with a different org in headers
    const CROSS_ORG_AUTH = {
      "x-api-key": "test-api-key",
      "x-org-id": "b645207b-d8e9-40b0-9391-072b777cd9a9",
      "x-user-id": "user-b",
      "x-run-id": "run-caller-b",
      "x-brand-id": "brand-b",
      "x-campaign-id": "camp-b",
      "x-workflow-slug": "sales-outreach",
      "x-feature-slug": "cold-outreach",
    };

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-pharaoh/execute")
      .set(CROSS_ORG_AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    // Run is attributed to the executing org, not the deployer
    expect(res.body.orgId).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
    expect(res.body.userId).toBe("user-b");
  });

  it("uses x-org-id header for identity (orgId not in body)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "simple-flow",
      workflowName: "Simple Flow",
      workflowDynastySlug: "simple-flow",
      workflowDynastyName: "Simple Flow",
      version: 1,
      windmillFlowPath: "f/workflows/org_1/simple_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    const res = await request
      .post("/workflows/by-slug/simple-flow/execute")
      .set(AUTH)
      .send({ inputs: {} }); // no orgId in body

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("user-1");
    expect(res.body.orgId).toBe("org-1");
  });

  it("returns 404 for unknown workflow slug", async () => {
    const res = await request
      .post("/workflows/by-slug/nonexistent/execute")
      .set(AUTH)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
  });

  it("follows upgrade chain and executes active replacement", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated workflow
        id: WF_OLD_ID,
        workflowSlug: "deprecated-flow",
        workflowName: "Deprecated Flow",
        workflowDynastySlug: "deprecated-flow",
        workflowDynastyName: "Deprecated Flow",
        version: 1,
        status: "deprecated",
      }],
      [{   // 3. successor lookup via created_from_workflow → active replacement
        id: WF_NEW_ID,
        workflowSlug: "replacement-flow",
        workflowName: "Replacement Flow",
        workflowDynastySlug: "replacement-flow",
        workflowDynastyName: "Replacement Flow",
        version: 2,
        status: "active",
        windmillFlowPath: "f/workflows/org_1/replacement_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/deprecated-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/replacement_flow",
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("follows multi-hop upgrade chain to active version", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated v1
        id: WF_V1_ID,
        workflowSlug: "old-flow",
        workflowName: "Old Flow",
        workflowDynastySlug: "old-flow",
        workflowDynastyName: "Old Flow",
        version: 1,
        status: "deprecated",
      }],
      [{   // 3. successor of v1 → v2 (also deprecated)
        id: WF_V2_ID,
        workflowSlug: "mid-flow",
        workflowName: "Mid Flow",
        workflowDynastySlug: "mid-flow",
        workflowDynastyName: "Mid Flow",
        version: 2,
        status: "deprecated",
      }],
      [{   // 4. successor of v2 → v3 (active)
        id: WF_V3_ID,
        workflowSlug: "current-flow",
        workflowName: "Current Flow",
        workflowDynastySlug: "current-flow",
        workflowDynastyName: "Current Flow",
        version: 3,
        status: "active",
        windmillFlowPath: "f/workflows/org_1/current_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/old-flow/execute")
      .set(AUTH)
      .send({ inputs: { key: "value" } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/current_flow",
      expect.objectContaining({ orgId: "org-1", key: "value" }),
    );
  });

  it("returns 410 when upgrade chain ends without active workflow", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated, no successor
        id: WF_DEAD_ID,
        workflowSlug: "dead-flow",
        workflowName: "Dead Flow",
        workflowDynastySlug: "dead-flow",
        workflowDynastyName: "Dead Flow",
        version: 1,
        status: "deprecated",
      }],
      [],  // 3. successor lookup → none
    );

    const res = await request
      .post("/workflows/by-slug/dead-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBeNull();
    expect(res.body.upgradedToWorkflowSlug).toBeNull();
  });

  it("returns 410 with first successor when chain leads to a deprecated successor with no further upgrade", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → original deprecated row
        id: WF_OLD_ID,
        workflowSlug: "orphan-flow",
        workflowName: "Orphan Flow",
        workflowDynastySlug: "orphan-flow",
        workflowDynastyName: "Orphan Flow",
        version: 1,
        status: "deprecated",
      }],
      [{   // 3. successor → also deprecated
        id: WF_MISSING_ID,
        workflowSlug: "orphan-successor",
        status: "deprecated",
      }],
      [],  // 4. successor of the successor → none, break
    );

    const res = await request
      .post("/workflows/by-slug/orphan-flow/execute")
      .set(AUTH)
      .send({ inputs: {} });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Workflow has been deprecated");
    expect(res.body.upgradedTo).toBe(WF_MISSING_ID);
    expect(res.body.upgradedToWorkflowSlug).toBe("orphan-successor");
  });

  it("uses campaignId from header into Windmill flow inputs (by slug)", async () => {
    mockWorkflows.push({
      id: WF_ID,
      orgId: "deployer-org",
      workflowSlug: "campaign-flow",
      workflowName: "Campaign Flow",
      workflowDynastySlug: "campaign-flow",
      workflowDynastyName: "Campaign Flow",
      version: 1,
      campaignId: "camp-on-record",
      createdForBrandId: "brand-on-record",
      subrequestId: null,
      windmillFlowPath: "f/workflows/org_1/campaign_flow",
      windmillWorkspace: "prod",
      dag: VALID_LINEAR_DAG,
    });

    await request
      .post("/workflows/by-slug/campaign-flow/execute")
      .set(AUTH) // x-campaign-id: "camp-1", x-brand-id: "brand-1"
      .send({ inputs: {} });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/campaign_flow",
      expect.objectContaining({
        campaignId: "camp-1",
        brandId: "brand-1",
      }),
    );
  });

  it("returns 400 when required execution headers are missing (by slug)", async () => {
    const res = await request
      .post("/workflows/by-slug/some-flow/execute")
      .set({ "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" })
      .send({ inputs: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
    expect(res.body.error).toContain("x-campaign-id");
  });

  it("stores campaignId from header when following upgrade chain", async () => {
    mockSelectResponses.push(
      [],  // 1. active-only lookup → not found
      [{   // 2. any-status lookup → deprecated workflow
        id: WF_OLD_ID,
        workflowSlug: "old-flow",
        workflowName: "Old Flow",
        workflowDynastySlug: "old-flow",
        workflowDynastyName: "Old Flow",
        version: 1,
        status: "deprecated",
        campaignId: null,
        subrequestId: null,
        upgradedTo: WF_NEW_ID,
      }],
      [{   // 3. chain follow: replacement is active
        id: WF_NEW_ID,
        workflowSlug: "new-flow",
        workflowName: "New Flow",
        workflowDynastySlug: "new-flow",
        workflowDynastyName: "New Flow",
        version: 2,
        status: "active",
        campaignId: null,
        subrequestId: null,
        windmillFlowPath: "f/workflows/org_1/new_flow",
        windmillWorkspace: "prod",
        dag: VALID_LINEAR_DAG,
      }],
    );

    const res = await request
      .post("/workflows/by-slug/old-flow/execute")
      .set(AUTH) // x-campaign-id: "camp-1"
      .send({ inputs: { subrequestId: "sub-runtime" } });

    expect(res.status).toBe(201);
    expect(res.body.campaignId).toBe("camp-1");
    expect(res.body.subrequestId).toBe("sub-runtime");
  });

  it("requires authentication", async () => {
    const res = await request
      .post("/workflows/by-slug/test-flow/execute")
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
    const attributionContext = {
      brandId: "brand-1",
      brandIds: ["brand-1"],
      campaignId: "camp-1",
      featureSlug: "test-feature",
      goal: "signup",
      brandProfileId: "brand-profile-real-1",
      customerPersonaId: "customer-persona-real-1",
      customerProfileId: "customer-profile-real-1",
      profileId: "profile-real-1",
      personaId: "persona-real-1",
      goalId: "goal-real-1",
      goalSlug: "signups",
    };
    mockRuns.push({
      id: RUN_1_ID,
      workflowId: WF_ID,
      orgId: "org-1",
      userId: "user-1",
      runId: "run-own-poll",
      campaignId: "camp-1",
      featureSlug: "test-feature",
      status: "running",
      windmillJobId: "job-uuid-123",
      windmillWorkspace: "prod",
      attributionContext,
      inputs: {},
      result: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
    });

    const res = await request.get(`/workflow-runs/${RUN_1_ID}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result).toEqual({ output: "done" });
    expect(res.body.attributionContext).toEqual(attributionContext);
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
      id: RUN_DEBUG_ID,
      workflowId: WF_ID,
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
      .get(`/workflow-runs/${RUN_DEBUG_ID}/debug`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(RUN_DEBUG_ID);
    expect(res.body.windmillJobId).toBe("job-uuid-789");
    expect(res.body.flowStatus).toEqual(flowStatus);
    expect(res.body.flowStatus.modules).toHaveLength(3);
    expect(res.body.flowStatus.modules[0].result.lead.data.firstName).toBe("Alice");
  });

  it("returns 404 for unknown run", async () => {
    const res = await request
      .get(`/workflow-runs/ffffffff-ffff-4fff-bfff-ffffffffffff/debug`)
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("returns 400 if run has no windmill job ID", async () => {
    mockRuns.push({
      id: RUN_NO_JOB_ID,
      workflowId: WF_ID,
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
      .get(`/workflow-runs/${RUN_NO_JOB_ID}/debug`)
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
      id: RUN_SIMPLE_ID,
      workflowId: WF_ID,
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
      .get(`/workflow-runs/${RUN_SIMPLE_ID}/debug`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.flowStatus).toBeNull();
  });

  it("requires authentication", async () => {
    const res = await request
      .get(`/workflow-runs/${RUN_1_ID}/debug`)
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
      id: RUN_1_ID,
      workflowId: WF_ID,
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
      .post(`/workflow-runs/${RUN_1_ID}/cancel`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockCancelJob).toHaveBeenCalled();
  });
});

describe("x-feature-slug tracking", () => {
  beforeEach(() => {
    mockWorkflows.length = 0;
    mockRuns.length = 0;
    mockSelectResponses.length = 0;
    mockRunFlow.mockReset();
    mockRunFlow.mockResolvedValue("job-uuid-123");
    mockCreateRun.mockClear();
    mockCreateRun.mockResolvedValue({ runId: "run-feat-1" });
    mockCloseRun.mockClear();
    mockCloseRun.mockResolvedValue(undefined);
  });

  const WORKFLOW_FIXTURE = {
    id: WF_FEAT_ID,
    orgId: "org-1",
    workflowSlug: "sales-email-cold-outreach-sequoia",
    workflowName: "Sales Email Cold Outreach Sequoia",
    workflowDynastySlug: "sales-email-cold-outreach-sequoia",
    workflowDynastyName: "Sales Email Cold Outreach Sequoia",
    version: 1,
    campaignId: null,
    subrequestId: null,
    createdForBrandId: null,
    windmillFlowPath: "f/workflows/org_1/sales_email",
    windmillWorkspace: "prod",
    dag: VALID_LINEAR_DAG,
  };

  it("stores featureSlug from x-feature-slug header in the run (execute by slug)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("sales-email-cold-outreach");
  });

  it("stores featureSlug from x-feature-slug header in the run (execute by id)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post(`/workflows/${WF_FEAT_ID}/execute`)
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: {} });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("sales-email-cold-outreach");
  });

  it("uses featureSlug from header (inputs do not override)", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    const res = await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "from-header" })
      .send({ inputs: { featureSlug: "from-inputs" } });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("from-header");
  });

  it("forwards featureSlug into Windmill flow inputs", async () => {
    mockWorkflows.push(WORKFLOW_FIXTURE);

    await request
      .post("/workflows/by-slug/sales-email-cold-outreach-sequoia/execute")
      .set({ ...AUTH, "x-feature-slug": "sales-email-cold-outreach" })
      .send({ inputs: { email: "test@example.com" } });

    expect(mockRunFlow).toHaveBeenCalledWith(
      "f/workflows/org_1/sales_email",
      expect.objectContaining({ featureSlug: "sales-email-cold-outreach", email: "test@example.com" }),
    );
  });

});

describe("UUID validation on :id routes", () => {
  it("POST /workflows/:id/execute returns 400 for non-UUID id", async () => {
    const res = await request
      .post("/workflows/new/execute")
      .set(AUTH)
      .send({ inputs: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("GET /workflow-runs/:id returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflow-runs/latest").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });

  it("GET /workflow-runs/:id/debug returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflow-runs/abc/debug").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });

  it("POST /workflow-runs/:id/cancel returns 400 for non-UUID id", async () => {
    const res = await request.post("/workflow-runs/abc/cancel").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid run ID format");
  });
});
