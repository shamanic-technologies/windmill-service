import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// --- Mock DB with table awareness ---
const mockWorkflowRows: Record<string, unknown>[] = [];
const mockWorkflowRunRows: Record<string, unknown>[] = [];

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
const mockFetchRunCostsAuth = vi.fn();
const mockFetchEmailStatsAuth = vi.fn();
const mockFetchRunCostsPublic = vi.fn();
const mockFetchEmailStatsPublic = vi.fn();

vi.mock("../../src/lib/stats-client.js", () => ({
  fetchRunCostsAuth: (...args: unknown[]) => mockFetchRunCostsAuth(...args),
  fetchEmailStatsAuth: (...args: unknown[]) => mockFetchEmailStatsAuth(...args),
  fetchRunCostsPublic: (...args: unknown[]) => mockFetchRunCostsPublic(...args),
  fetchEmailStatsPublic: (...args: unknown[]) => mockFetchEmailStatsPublic(...args),
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
}));

// --- Mock features-client ---
vi.mock("../../src/lib/features-client.js", () => ({
  fetchFeatureOutputs: vi.fn().mockResolvedValue([{ key: "emailsReplied", displayOrder: 0 }]),
  fetchStatsRegistry: vi.fn().mockResolvedValue({ emailsReplied: { type: "count", label: "Replies" } }),
}));

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);

const DEFAULT_WF_SLUG = "sales-email-cold-outreach-alpha";

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf-" + Math.random().toString(36).slice(2, 10),
    orgId: "org1",
    workflowSlug: DEFAULT_WF_SLUG,
    workflowName: "Sales Email Cold Outreach Alpha",
    workflowDynastySlug: DEFAULT_WF_SLUG,
    workflowDynastyName: "Sales Email Cold Outreach Alpha",
    version: 1,
    createdForBrandId: null,
    description: null,
    featureSlug: "sales-email-cold-outreach",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    signature: "sig-" + Math.random().toString(36).slice(2, 8),
    workflowDynastySignatureName: "alpha",
    dag: VALID_LINEAR_DAG,
    windmillFlowPath: "f/workflows/test/flow",
    windmillWorkspace: "prod",
    status: "active",
    upgradedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ==================== GET /public/workflows ====================

describe("GET /public/workflows", () => {
  const API_KEY = { "x-api-key": "test-api-key" };

  beforeEach(() => {
    mockWorkflowRows.length = 0;
  });

  it("returns 401 without x-api-key", async () => {
    const res = await request.get("/public/workflows").query({ featureSlugs: "sales-v1" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when featureSlugs is missing", async () => {
    const res = await request.get("/public/workflows").set(API_KEY);
    expect(res.status).toBe(400);
  });

  it("returns workflows for given feature slugs (mock returns all rows)", async () => {
    const wf1 = makeWorkflow({ id: "wf-a1", featureSlug: "sales-v1", status: "active" });
    const wf2 = makeWorkflow({ id: "wf-a2", featureSlug: "sales-v2", status: "active", workflowSlug: "sales-cold-outreach-alpha-v2", workflowName: "Sales Alpha v2", workflowDynastySlug: "sales-cold-outreach-alpha", workflowDynastyName: "Sales Cold Outreach Alpha" });
    mockWorkflowRows.push(wf1, wf2);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "sales-v1,sales-v2" });

    expect(res.status).toBe(200);
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.workflows.map((w: { id: string }) => w.id);
    expect(ids).toContain("wf-a1");
    expect(ids).toContain("wf-a2");
  });

  it("passes status filter to DB query and computes upgradedTo from successor row", async () => {
    // upgradedTo is now derived from a successor row that points back via
    // created_from_workflow with creation_type='upgrade'. The successor must
    // therefore be in the result set for the lookup to resolve.
    const wfDepr = makeWorkflow({
      id: "wf-dep",
      featureSlug: "feat-x",
      status: "deprecated",
      workflowSlug: "feat-dep",
      workflowName: "Depr",
      workflowDynastySlug: "feat-dep",
      workflowDynastyName: "Depr",
      creationType: "scratch",
      createdFromWorkflow: null,
    });
    const wfActive = makeWorkflow({
      id: "wf-act-uuid",
      featureSlug: "feat-x",
      status: "active",
      workflowSlug: "feat-act",
      workflowName: "Act",
      workflowDynastySlug: "feat-dep",
      workflowDynastyName: "Depr",
      creationType: "upgrade",
      createdFromWorkflow: "wf-dep",
    });
    mockWorkflowRows.push(wfDepr, wfActive);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "feat-x", status: "all" });

    expect(res.status).toBe(200);
    const dep = res.body.workflows.find((w: { id: string }) => w.id === "wf-dep");
    expect(dep).toBeDefined();
    expect(dep.upgradedTo).toBe("wf-act-uuid");
  });

  it("returns workflows with status=all", async () => {
    const wf1 = makeWorkflow({ id: "wf-all-1", featureSlug: "feat-y", status: "active" });
    const wf2 = makeWorkflow({ id: "wf-all-2", featureSlug: "feat-y", status: "deprecated", workflowSlug: "feat-y-old", workflowName: "Old", workflowDynastySlug: "feat-y-old", workflowDynastyName: "Old" });
    mockWorkflowRows.push(wf1, wf2);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "feat-y", status: "all" });

    expect(res.status).toBe(200);
    expect(res.body.workflows.length).toBeGreaterThanOrEqual(2);
  });

  it("returns correct shape with all expected fields", async () => {
    const wf = makeWorkflow({
      id: "wf-shape",
      workflowSlug: "sales-cold-outreach-obsidian-v3",
      workflowName: "Sales Cold Outreach Obsidian v3",
      workflowDynastySlug: "sales-cold-outreach-obsidian",
      workflowDynastyName: "Sales Cold Outreach Obsidian",
      version: 3,
      featureSlug: "sales-cold-outreach-v2",
      createdForBrandId: "brand-123",
      status: "active",
      upgradedTo: null,
    });
    mockWorkflowRows.push(wf);

    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "sales-cold-outreach-v2" });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    const w = res.body.workflows[0];
    expect(w).toEqual({
      id: "wf-shape",
      workflowSlug: "sales-cold-outreach-obsidian-v3",
      workflowName: "Sales Cold Outreach Obsidian v3",
      workflowDynastySlug: "sales-cold-outreach-obsidian",
      workflowDynastyName: "Sales Cold Outreach Obsidian",
      version: 3,
      status: "active",
      featureSlug: "sales-cold-outreach-v2",
      createdForBrandId: "brand-123",
      upgradedTo: null,
    });
    // Must NOT include DAG or internal fields
    expect(w).not.toHaveProperty("dag");
    expect(w).not.toHaveProperty("orgId");
    expect(w).not.toHaveProperty("signature");
    expect(w).not.toHaveProperty("windmillFlowPath");
  });

  it("returns empty array when no workflows match", async () => {
    const res = await request
      .get("/public/workflows")
      .set(API_KEY)
      .query({ featureSlugs: "nonexistent-feature" });

    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual([]);
  });
});

// ==================== GET /workflows/dynasty/slugs ====================
// Regression (features-service #526): this route resolves a global cross-org dynasty
// slug for org-less, api-key-only callers (runs-service / email-gateway public analytics).
// It must succeed with NO x-org-id / x-user-id / x-run-id — previously it lived behind
// the global requireIdentity gate and 400'd "identity headers required".

describe("GET /workflows/dynasty/slugs", () => {
  const API_KEY = { "x-api-key": "test-api-key" };

  beforeEach(() => {
    mockWorkflowRows.length = 0;
  });

  it("resolves dynasty slug to versioned slugs with api-key and NO identity headers", async () => {
    const v1 = makeWorkflow({
      id: "wf-d1",
      workflowSlug: "sales-cold-outreach-obsidian",
      workflowDynastySlug: "sales-cold-outreach-obsidian",
      workflowDynastyName: "Sales Cold Outreach Obsidian",
      version: 1,
    });
    const v2 = makeWorkflow({
      id: "wf-d2",
      workflowSlug: "sales-cold-outreach-obsidian-v2",
      workflowDynastySlug: "sales-cold-outreach-obsidian",
      workflowDynastyName: "Sales Cold Outreach Obsidian",
      version: 2,
    });
    mockWorkflowRows.push(v1, v2);

    // Deliberately send ONLY the api-key — no x-org-id / x-user-id / x-run-id.
    const res = await request
      .get("/workflows/dynasty/slugs")
      .set(API_KEY)
      .query({ workflowDynastySlug: "sales-cold-outreach-obsidian" });

    expect(res.status).toBe(200);
    expect(res.body.workflowDynastySlug).toBe("sales-cold-outreach-obsidian");
    expect(res.body.workflowDynastyName).toBe("Sales Cold Outreach Obsidian");
    expect(res.body.workflowSlugs).toEqual(
      expect.arrayContaining([
        "sales-cold-outreach-obsidian",
        "sales-cold-outreach-obsidian-v2",
      ]),
    );
  });

  it("still works for identity-scoped callers (identity headers present)", async () => {
    mockWorkflowRows.push(makeWorkflow({ id: "wf-d3" }));

    const res = await request
      .get("/workflows/dynasty/slugs")
      .set(API_KEY)
      .set({ "x-org-id": "org1", "x-user-id": "user1", "x-run-id": "run1" })
      .query({ workflowDynastySlug: DEFAULT_WF_SLUG });

    expect(res.status).toBe(200);
    expect(res.body.workflowSlugs).toContain(DEFAULT_WF_SLUG);
  });

  it("returns 401 without x-api-key", async () => {
    const res = await request
      .get("/workflows/dynasty/slugs")
      .query({ workflowDynastySlug: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when workflowDynastySlug is missing", async () => {
    const res = await request.get("/workflows/dynasty/slugs").set(API_KEY);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no workflows match the dynasty slug", async () => {
    const res = await request
      .get("/workflows/dynasty/slugs")
      .set(API_KEY)
      .query({ workflowDynastySlug: "does-not-exist" });
    expect(res.status).toBe(404);
  });
});
