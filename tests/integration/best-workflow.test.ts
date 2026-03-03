import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// --- Mock DB with table awareness ---
const mockWorkflowRows: Record<string, unknown>[] = [];
const mockWorkflowRunRows: Record<string, unknown>[] = [];

// Track which table is being queried
const workflowsTableMarker = Symbol("workflows");
const workflowRunsTableMarker = Symbol("workflowRuns");

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
        mockWorkflowRows.push(newRow);
        return {
          returning: () => Promise.resolve([newRow]),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        // Determine which table is being queried based on the table reference
        const isWorkflowRuns =
          table &&
          typeof table === "object" &&
          "workflowId" in (table as Record<string, unknown>);

        const rows = isWorkflowRuns ? mockWorkflowRunRows : mockWorkflowRows;
        const result = Promise.resolve(rows);
        (result as any).where = (_condition?: unknown) => Promise.resolve(rows);
        return result;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const row = mockWorkflowRows[mockWorkflowRows.length - 1];
          if (row) Object.assign(row, values);
          return {
            returning: () => Promise.resolve([{ ...row, ...values }]),
          };
        },
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
  sql: {
    end: () => Promise.resolve(),
  },
}));

// --- Mock stats-client ---
const mockFetchRunCosts = vi.fn();
const mockFetchEmailStats = vi.fn();

vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCosts: (...args: unknown[]) => mockFetchRunCosts(...args),
  fetchEmailStats: (...args: unknown[]) => mockFetchEmailStats(...args),
}));

// --- Mock Windmill ---
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

// --- Mock key-service ---
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: vi.fn(),
  fetchAnthropicKey: vi.fn(),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

const BASE_QUERY = {
  orgId: "org1",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  objective: "replies",
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    name: "sales-email-cold-outreach-alpha",
    displayName: null,
    description: null,
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    signature: "sig-" + Math.random().toString(36).slice(2, 8),
    signatureName: "alpha",
    dag: VALID_LINEAR_DAG,
    windmillFlowPath: "f/workflows/test/flow",
    windmillWorkspace: "prod",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRun(workflowId: string, runId: string) {
  return {
    id: "wr-" + Math.random().toString(36).slice(2, 10),
    workflowId,
    runId,
    orgId: "org1",
    campaignId: null,
    subrequestId: null,
    windmillJobId: "wm-job-1",
    windmillWorkspace: "prod",
    status: "completed",
    inputs: null,
    result: null,
    error: null,
    startedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
  };
}

const EMPTY_STATS = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  recipients: 0,
};

describe("GET /workflows/best", () => {
  beforeEach(() => {
    mockWorkflowRows.length = 0;
    mockWorkflowRunRows.length = 0;
    mockFetchRunCosts.mockReset();
    mockFetchEmailStats.mockReset();
  });

  it("returns the best workflow by cost_per_reply", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(
      makeRun("wf-a", "ext-run-1"),
      makeRun("wf-a", "ext-run-2"),
    );

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
      { runId: "ext-run-2", totalCostInUsdCents: 200 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 10 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/best")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflow.id).toBe("wf-a");
    expect(res.body.dag).toBeDefined();
    expect(res.body.stats.totalCostInUsdCents).toBe(300);
    expect(res.body.stats.totalOutcomes).toBe(10);
    expect(res.body.stats.costPerOutcome).toBe(30);
    expect(res.body.stats.completedRuns).toBe(2);
  });

  it("uses clicks objective when specified", async () => {
    const wf = makeWorkflow({ id: "wf-a" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 500 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, clicked: 25 },
      broadcast: { ...EMPTY_STATS, clicked: 25 },
    });

    const res = await request
      .get("/workflows/best")
      .query({ ...BASE_QUERY, objective: "clicks" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.stats.totalOutcomes).toBe(50);
    expect(res.body.stats.costPerOutcome).toBe(10);
  });

  it("accepts partial filters (all optional)", async () => {
    // With only category set and no matching workflows, should return 404 (not 400)
    const res = await request
      .get("/workflows/best")
      .query({ category: "sales" })
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("returns best workflow with no filters (defaults objective to replies)", async () => {
    const wf = makeWorkflow({ id: "wf-nofilter" });
    mockWorkflowRows.push(wf);
    mockWorkflowRunRows.push(makeRun("wf-nofilter", "ext-run-nf"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-nf", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS, replied: 5 },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/best")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflow.id).toBe("wf-nofilter");
    expect(res.body.stats.totalOutcomes).toBe(5);
  });

  it("returns 404 when no workflows match", async () => {
    const res = await request
      .get("/workflows/best")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No workflows found/);
  });

  it("returns 404 when no completed runs exist", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    // No runs in mockWorkflowRunRows

    const res = await request
      .get("/workflows/best")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No completed runs/);
  });

  it("returns 502 when email-gateway-service fails", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockRejectedValue(
      new Error(
        "email-gateway-service error: POST /stats -> 500 Internal Server Error: boom"
      )
    );

    const res = await request
      .get("/workflows/best")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/email-gateway-service error/);
  });

  it("requires authentication", async () => {
    const res = await request
      .get("/workflows/best")
      .set(IDENTITY)
      .query(BASE_QUERY);

    expect(res.status).toBe(401);
  });

  it("rejects invalid objective value", async () => {
    const res = await request
      .get("/workflows/best")
      .query({ ...BASE_QUERY, objective: "conversions" })
      .set(AUTH);

    expect(res.status).toBe(400);
  });

  it("handles workflow with zero outcomes (costPerOutcome is null)", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-a" }));
    mockWorkflowRunRows.push(makeRun("wf-a", "ext-run-1"));

    mockFetchRunCosts.mockResolvedValue([
      { runId: "ext-run-1", totalCostInUsdCents: 100 },
    ]);
    mockFetchEmailStats.mockResolvedValue({
      transactional: { ...EMPTY_STATS },
      broadcast: { ...EMPTY_STATS },
    });

    const res = await request
      .get("/workflows/best")
      .query(BASE_QUERY)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.stats.costPerOutcome).toBeNull();
    expect(res.body.stats.completedRuns).toBe(1);
  });
});
