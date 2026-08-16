import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_UNKNOWN_TYPE,
  DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
  DAG_WITH_HTTP_CALL,
  DAG_WITH_HTTP_CALL_CHAIN,
  DAG_WITH_CONTENT_GEN_MISSING_VAR,
  DAG_WITH_CONTENT_GEN_ALL_VARS,
} from "../helpers/fixtures.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";

// Mock DB
const mockDbRows: Record<string, unknown>[] = [];
// Optional queue: when populated, select().from().where() shifts from it instead of returning mockDbRows
const mockSelectResponses: Record<string, unknown>[][] = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
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
        (result as any).where = (_condition?: unknown) =>
          Promise.resolve(
            mockSelectResponses.length > 0 ? mockSelectResponses.shift()! : mockDbRows,
          );
        return result;
      },
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

// Mock key-service client
const mockFetchProviderRequirements = vi.fn();
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchProviderRequirements: (...args: unknown[]) =>
    mockFetchProviderRequirements(...args),
}));

// Mock content-generation client (for template contract validation)
const mockFetchPromptTemplates = vi.fn().mockResolvedValue(new Map());
vi.mock("../../src/lib/content-generation-client.js", () => ({
  fetchPromptTemplate: vi.fn().mockResolvedValue(null),
  fetchPromptTemplates: (...args: unknown[]) =>
    mockFetchPromptTemplates(...args),
}));

// Mock api-registry-client (used by /validate to fetch OpenAPI specs)
const buildContentGenSpec = () => ({
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
                  variables: {
                    type: "object",
                    additionalProperties: true,
                  },
                  // Version-free alias drawn from a closed set, as deployed.
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
                required: ["type"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string" },
                    subject: { type: "string" },
                    bodyHtml: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
const mockFetchSpecsForServices = vi.fn(async (services: string[]) => {
  const specs = new Map<string, Record<string, unknown>>();
  for (const s of services) {
    if (s === "content-generation") specs.set(s, buildContentGenSpec());
  }
  return specs;
});
vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchSpecsForServices: (...args: unknown[]) =>
    mockFetchSpecsForServices(...(args as [string[]])),
  fetchServiceList: vi.fn().mockResolvedValue([]),
  fetchServiceSpec: vi.fn().mockResolvedValue({}),
  fetchLlmContext: vi.fn().mockResolvedValue({ services: [] }),
  fetchServiceEndpoints: vi.fn().mockResolvedValue({ service: "", endpoints: [] }),
}));

// Mock features-client
vi.mock("../../src/lib/features-client.js", () => ({}));

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

import supertest from "supertest";
import app from "../../src/index.js";

const request = supertest(app);
const IDENTITY = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" };
const AUTH = { "x-api-key": "test-api-key", ...IDENTITY };

// Valid UUID test IDs
const WF_ID = "00000000-0000-4000-8000-000000000001";
const WF_FEATURE_ID = "00000000-0000-4000-8000-000000000002";
const WF_EXISTING_ID = "00000000-0000-4000-8000-000000000003";
const WF_HTTP_ID = "00000000-0000-4000-8000-000000000004";
const WF_LEGACY_ID = "00000000-0000-4000-8000-000000000005";
const WF_META_ID = "00000000-0000-4000-8000-000000000006";
const WF_DAG_REJECT_ID = "00000000-0000-4000-8000-000000000007";

describe("POST /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("creates a workflow with valid DAG", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-cold-email-outreach",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.workflowSlug).toBeTruthy();
    expect(res.body.workflowName).toBeTruthy();
    expect(res.body.version).toBe(1);
    expect(res.body.orgId).toBe("org-1");
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.tags).toEqual([]);
    expect(res.body.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.workflowDynastySignatureName).toBeTruthy();
    expect(res.body.windmillFlowPath).toContain("f/workflows/org-1/");
  });

  it("creates a workflow with tags", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-multi-channel",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        tags: ["email", "linkedin"],
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual(["email", "linkedin"]);
  });

  it("rejects an invalid DAG (unknown node type rejected by Zod enum)", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "sales-bad-flow",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        dag: DAG_WITH_UNKNOWN_TYPE,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(res.body.details).toBeDefined();
  });


  it("requires authentication", async () => {
    const res = await request
      .post("/workflows")
      .set(IDENTITY)
      .send({
        featureSlug: "no-auth-test",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(401);
  });

  it("validates request body with Zod", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      // Missing required fields (no featureSlug, no dag)
      description: "Incomplete",
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /workflows", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockFetchProviderRequirements.mockReset();
    // Default key-service response so existing list tests (whose fixtures may
    // contain http.call nodes like VALID_LINEAR_DAG) don't 500 on undefined.
    // Cases that exercise the enrichment override this with mockResolvedValue.
    mockFetchProviderRequirements.mockResolvedValue({ requirements: [], providers: [] });
  });

  it("returns all workflows when no filters provided", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-1",
      workflowName: "Flow 1",
      workflowDynastySlug: "flow-1",
      workflowDynastyName: "Flow 1",
      version: 1,
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
  });

  it("returns workflows for orgId", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-1",
      workflowName: "Flow 1",
      workflowDynastySlug: "flow-1",
      workflowDynastyName: "Flow 1",
      version: 1,
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("creates a workflow with featureSlug and returns it in response", async () => {
    const res = await request
      .post("/workflows")
      .set(AUTH)
      .send({
        createdForBrandId: "brand-test-001",
        featureSlug: "outlet-database-discovery",
        category: "outlets",
        channel: "database",
        audienceType: "discovery",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(201);
    expect(res.body.featureSlug).toBe("outlet-database-discovery");
  });

  it("filters workflows by featureSlug", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      workflowSlug: "outlet-database-discovery-sequoia",
      workflowName: "Outlet Database Discovery Sequoia",
      workflowDynastySlug: "outlet-database-discovery-sequoia",
      workflowDynastyName: "Outlet Database Discovery Sequoia",
      version: 1,
      featureSlug: "outlet-database-discovery",
      category: "outlets",
      channel: "database",
      audienceType: "discovery",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ featureSlug: "outlet-database-discovery" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
    expect(res.body.workflows[0].featureSlug).toBe("outlet-database-discovery");
  });

  it("filters workflows by workflowSlug", async () => {
    mockDbRows.push({
      id: WF_FEATURE_ID,
      orgId: "org-1",
      workflowSlug: "sales-cold-email-outreach-sequoia",
      workflowName: "Sales Cold Email Outreach Sequoia",
      workflowDynastySlug: "sales-cold-email-outreach-sequoia",
      workflowDynastyName: "Sales Cold Email Outreach Sequoia",
      version: 1,
      featureSlug: "sales-cold-email-outreach",
      status: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ workflowSlug: "sales-cold-email-outreach-sequoia" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toBeDefined();
  });

  it("returns dimensions in response", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "sales-cold-email-outreach-sequoia",
      workflowName: "Sales Cold Email Outreach Sequoia",
      workflowDynastySlug: "sales-cold-email-outreach-sequoia",
      workflowDynastyName: "Sales Cold Email Outreach Sequoia",
      version: 1,
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      signature: "abc123",
      workflowDynastySignatureName: "sequoia",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get("/workflows")
      .query({ orgId: "org-1" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].featureSlug).toBe("sales-cold-email-outreach");
    // category, channel, audienceType are now optional — may or may not be present
    expect(res.body.workflows[0].category).toBe("sales");
    expect(res.body.workflows[0].channel).toBe("email");
    expect(res.body.workflows[0].audienceType).toBe("cold-outreach");
  });

  // --- requiredProviders enrichment (inlined to kill api-service N+1 fanout) ---

  it("returns empty list with no key-service call", async () => {
    const res = await request.get("/workflows").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual([]);
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });

  it("enriches each item with requiredProviders for workflows with http.call nodes", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { service: "stripe", method: "GET", path: "/products/prod_123", provider: "stripe" },
      ],
      providers: ["stripe"],
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].requiredProviders).toEqual([
      { name: "stripe", domain: "stripe.com" },
    ]);
    expect(mockFetchProviderRequirements).toHaveBeenCalledTimes(1);
    expect(mockFetchProviderRequirements).toHaveBeenCalledWith(
      [{ service: "stripe", method: "GET", path: "/products/prod_123" }],
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("dedupes endpoints across multiple workflows into a single key-service call", async () => {
    mockDbRows.push(
      {
        id: WF_HTTP_ID,
        orgId: "org-1",
        workflowSlug: "wf-a",
        workflowName: "WF A",
        workflowDynastySlug: "wf-a",
        workflowDynastyName: "WF A",
        version: 1,
        dag: DAG_WITH_HTTP_CALL_CHAIN, // client POST /users + transactional-email POST /send
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: WF_FEATURE_ID,
        orgId: "org-1",
        workflowSlug: "wf-b",
        workflowName: "WF B",
        workflowDynastySlug: "wf-b",
        workflowDynastyName: "WF B",
        version: 1,
        dag: DAG_WITH_HTTP_CALL, // stripe GET /products/prod_123
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: WF_LEGACY_ID,
        orgId: "org-1",
        workflowSlug: "wf-c",
        workflowName: "WF C",
        workflowDynastySlug: "wf-c",
        workflowDynastyName: "WF C",
        version: 1,
        dag: DAG_WITH_HTTP_CALL_CHAIN, // duplicate of wf-a's endpoints
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { service: "client", method: "POST", path: "/users", provider: "client" },
        { service: "transactional-email", method: "POST", path: "/send", provider: "postmark" },
        { service: "stripe", method: "GET", path: "/products/prod_123", provider: "stripe" },
      ],
      providers: ["client", "postmark", "stripe"],
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(3);

    // Single key-service call, deduped to 3 unique endpoints (not 5)
    expect(mockFetchProviderRequirements).toHaveBeenCalledTimes(1);
    const [calledEndpoints] = mockFetchProviderRequirements.mock.calls[0];
    expect(calledEndpoints).toHaveLength(3);
    expect(calledEndpoints).toEqual(
      expect.arrayContaining([
        { service: "client", method: "POST", path: "/users" },
        { service: "transactional-email", method: "POST", path: "/send" },
        { service: "stripe", method: "GET", path: "/products/prod_123" },
      ]),
    );

    // Per-workflow provider mapping
    const byId = Object.fromEntries(res.body.workflows.map((w: any) => [w.id, w]));
    expect(byId[WF_HTTP_ID].requiredProviders).toEqual(
      expect.arrayContaining([
        { name: "client", domain: null },
        { name: "postmark", domain: "postmarkapp.com" },
      ]),
    );
    expect(byId[WF_HTTP_ID].requiredProviders).toHaveLength(2);
    expect(byId[WF_FEATURE_ID].requiredProviders).toEqual([
      { name: "stripe", domain: "stripe.com" },
    ]);
    // wf-c has same endpoints as wf-a, gets same providers
    expect(byId[WF_LEGACY_ID].requiredProviders).toEqual(
      expect.arrayContaining([
        { name: "client", domain: null },
        { name: "postmark", domain: "postmarkapp.com" },
      ]),
    );
  });

  it("returns empty requiredProviders for workflows without http.call nodes and skips key-service when none exist", async () => {
    mockDbRows.push({
      id: WF_LEGACY_ID,
      orgId: "org-1",
      workflowSlug: "legacy-flow",
      workflowName: "Legacy Flow",
      workflowDynastySlug: "legacy-flow",
      workflowDynastyName: "Legacy Flow",
      version: 1,
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].requiredProviders).toEqual([]);
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });

  it("handles mix of workflows with and without http.call nodes in one call", async () => {
    mockDbRows.push(
      {
        id: WF_HTTP_ID,
        orgId: "org-1",
        workflowSlug: "http-flow",
        workflowName: "HTTP Flow",
        workflowDynastySlug: "http-flow",
        workflowDynastyName: "HTTP Flow",
        version: 1,
        dag: DAG_WITH_HTTP_CALL,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: WF_LEGACY_ID,
        orgId: "org-1",
        workflowSlug: "legacy-flow",
        workflowName: "Legacy Flow",
        workflowDynastySlug: "legacy-flow",
        workflowDynastyName: "Legacy Flow",
        version: 1,
        dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { service: "stripe", method: "GET", path: "/products/prod_123", provider: "stripe" },
      ],
      providers: ["stripe"],
    });

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(200);
    expect(mockFetchProviderRequirements).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(res.body.workflows.map((w: any) => [w.id, w]));
    expect(byId[WF_HTTP_ID].requiredProviders).toEqual([
      { name: "stripe", domain: "stripe.com" },
    ]);
    expect(byId[WF_LEGACY_ID].requiredProviders).toEqual([]);
  });

  it("returns 502 when key-service fails", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockRejectedValue(
      new Error(
        "key-service error: POST /provider-requirements -> 500 Internal Server Error: boom"
      )
    );

    const res = await request.get("/workflows").set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("key-service error:");
  });
});

describe("GET /workflows/:id (single)", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockFetchProviderRequirements.mockReset();
  });

  it("does not inject requiredProviders on the single-workflow detail endpoint", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request.get(`/workflows/${WF_HTTP_ID}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.requiredProviders).toBeUndefined();
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });
});


describe("GET /workflows/:id/required-providers", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockFetchProviderRequirements.mockReset();
  });

  it("returns providers for a workflow with http.call nodes", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL_CHAIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { provider: "client", fields: ["apiKey"] },
        { provider: "transactional-email", fields: ["apiKey"] },
      ],
      providers: ["client", "transactional-email"],
    });

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.endpoints).toHaveLength(2);
    expect(res.body.providers).toEqual([
      { name: "client", domain: null },
      { name: "transactional-email", domain: null },
    ]);
    expect(mockFetchProviderRequirements).toHaveBeenCalledWith(
      [
        { service: "client", method: "POST", path: "/users" },
        { service: "transactional-email", method: "POST", path: "/send" },
      ],
      { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-caller-1", "x-brand-id": "brand-1" },
    );
  });

  it("enriches providers with domain info for known providers", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL_CHAIN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockResolvedValue({
      requirements: [
        { provider: "anthropic", fields: ["apiKey"] },
        { provider: "apollo", fields: ["apiKey"] },
      ],
      providers: ["anthropic", "apollo"],
    });

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { name: "anthropic", domain: "anthropic.com" },
      { name: "apollo", domain: "apollo.io" },
    ]);
  });

  it("returns empty providers for workflows with no http.call nodes", async () => {
    mockDbRows.push({
      id: WF_LEGACY_ID,
      orgId: "org-1",
      workflowSlug: "legacy-flow",
      workflowName: "Legacy Flow",
      workflowDynastySlug: "legacy-flow",
      workflowDynastyName: "Legacy Flow",
      version: 1,
      dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .get(`/workflows/${WF_LEGACY_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.endpoints).toEqual([]);
    expect(res.body.requirements).toEqual([]);
    expect(res.body.providers).toEqual([]);
    expect(mockFetchProviderRequirements).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .get("/workflows/ffffffff-ffff-4fff-bfff-ffffffffffff/required-providers")
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });

  it("returns 502 when key-service fails", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockRejectedValue(
      new Error(
        "key-service error: POST /provider-requirements -> 500 Internal Server Error: boom"
      )
    );

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("key-service error:");
  });

  it("returns 502 when KEY_SERVICE env vars are missing", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockFetchProviderRequirements.mockRejectedValue(
      new Error(
        "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"
      )
    );

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
  });

  it("returns 502 when key-service is unreachable (network error)", async () => {
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "http-flow",
      workflowName: "HTTP Flow",
      workflowDynastySlug: "http-flow",
      workflowDynastyName: "HTTP Flow",
      version: 1,
      dag: DAG_WITH_HTTP_CALL,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const err = new TypeError("fetch failed");
    (err as unknown as { cause: { code: string } }).cause = {
      code: "UND_ERR_CONNECT_TIMEOUT",
    };
    mockFetchProviderRequirements.mockRejectedValue(err);

    const res = await request
      .get(`/workflows/${WF_HTTP_ID}/required-providers`)
      .set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("key-service unreachable (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("requires authentication", async () => {
    const res = await request
      .get(`/workflows/${WF_ID}/required-providers`)
      .set(IDENTITY);
    expect(res.status).toBe(401);
  });
});

describe("PUT /workflows/:id — update (metadata, same-sig DAG, or fork)", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
  });

  it("updates in-place when only metadata changes (no DAG)", async () => {
    mockDbRows.push({
      id: WF_META_ID,
      orgId: "org-1",
      workflowSlug: "sales-email-cold-outreach-maple",
      workflowName: "Sales Email Cold Outreach Maple",
      workflowDynastySlug: "sales-email-cold-outreach-maple",
      workflowDynastyName: "Sales Email Cold Outreach Maple",
      featureSlug: "sales-email-cold-outreach",
      workflowDynastySignatureName: "maple",
      signature: "abc123",
      version: 1,
      description: "Old desc",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .put(`/workflows/${WF_META_ID}`)
      .set(AUTH)
      .send({
        description: "Updated description",
        tags: ["updated"],
      });

    expect(res.status).toBe(200);
    expect(res.body._action).toBe("updated");
    expect(res.body.description).toBe("Updated description");
    expect(res.body.tags).toEqual(["updated"]);
  });

  it("updates in-place when DAG has same signature", async () => {
    // Compute the real signature so it matches
    const { computeDAGSignature } = await import("../../src/lib/dag-signature.js");
    const realSig = computeDAGSignature(VALID_LINEAR_DAG);

    const existingWf = {
      id: WF_META_ID,
      orgId: "org-1",
      workflowSlug: "sales-email-cold-outreach-maple",
      workflowName: "Sales Email Cold Outreach Maple",
      workflowDynastySlug: "sales-email-cold-outreach-maple",
      workflowDynastyName: "Sales Email Cold Outreach Maple",
      featureSlug: "sales-email-cold-outreach",
      workflowDynastySignatureName: "maple",
      signature: realSig,
      version: 1,
      description: "Old desc",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillFlowPath: "f/workflows/org-1/sales_email_cold_outreach_maple",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queue: 1) existing lookup
    mockSelectResponses.push([existingWf]);

    // Send the same DAG — signature will match
    const res = await request
      .put(`/workflows/${WF_META_ID}`)
      .set(AUTH)
      .send({ dag: VALID_LINEAR_DAG, description: "Same DAG, new desc" });

    expect(res.status).toBe(200);
    expect(res.body._action).toBe("updated");
    expect(res.body.description).toBe("Same DAG, new desc");
  });

  it("forks when DAG has a new signature", async () => {
    const existingWf = {
      id: WF_DAG_REJECT_ID,
      orgId: "org-1",
      workflowSlug: "sales-email-cold-outreach-pine",
      workflowName: "Sales Email Cold Outreach Pine",
      workflowDynastySlug: "sales-email-cold-outreach-pine",
      workflowDynastyName: "Sales Email Cold Outreach Pine",
      featureSlug: "sales-email-cold-outreach",
      workflowDynastySignatureName: "pine",
      signature: "old-sig-123",
      version: 1,
      description: "Original",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Queue responses: 1) existing lookup, 2) conflict check (empty), 3) used workflowDynastySignatureNames
    mockSelectResponses.push([existingWf]); // existing workflow lookup
    mockSelectResponses.push([]); // no conflicting workflow with same signature
    mockSelectResponses.push([{ workflowDynastySignatureName: "pine" }]); // existing workflowDynastySignatureNames

    const res = await request
      .put(`/workflows/${WF_DAG_REJECT_ID}`)
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(201);
    expect(res.body._action).toBe("forked");
    expect(res.body._forkedFromWorkflowName).toBe("Sales Email Cold Outreach Pine");
    expect(res.body._forkedFromId).toBe(WF_DAG_REJECT_ID);
    expect(res.body._sourceDynastyDeprecated).toBeUndefined();
    expect(res.body.creationType).toBe("fork");
    expect(res.body.createdFromWorkflow).toBe(WF_DAG_REJECT_ID);
    expect(res.body.version).toBe(1);
    // Source workflow must remain active — no auto-deprecate-on-fork.
    expect(existingWf.status).toBe("active");
  });

  it("returns 409 with existingWorkflowId and existingWorkflowSlug when DAG signature conflicts", async () => {
    const conflictingId = "00000000-0000-4000-8000-000000000099";
    const existingWf = {
      id: WF_DAG_REJECT_ID,
      orgId: "org-1",
      workflowSlug: "sales-email-cold-outreach-pine",
      workflowName: "Sales Email Cold Outreach Pine",
      workflowDynastySlug: "sales-email-cold-outreach-pine",
      workflowDynastyName: "Sales Email Cold Outreach Pine",
      featureSlug: "sales-email-cold-outreach",
      workflowDynastySignatureName: "pine",
      signature: "old-sig-123",
      version: 1,
      description: "Original",
      dag: VALID_LINEAR_DAG,
      tags: [],
      status: "active",
      windmillWorkspace: "prod",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const conflictingWf = {
      id: conflictingId,
      workflowSlug: "sales-email-cold-outreach-maple",
    };

    // Queue responses: 1) existing lookup, 2) conflict check (found!)
    mockSelectResponses.push([existingWf]); // existing workflow lookup
    mockSelectResponses.push([conflictingWf]); // conflicting workflow with same new signature

    const res = await request
      .put(`/workflows/${WF_DAG_REJECT_ID}`)
      .set(AUTH)
      .send({ dag: DAG_WITH_TRANSACTIONAL_EMAIL_SEND });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("A workflow with this DAG signature already exists");
    expect(res.body.existingWorkflowId).toBe(conflictingId);
    expect(res.body.existingWorkflowSlug).toBe("sales-email-cold-outreach-maple");
  });

  it("returns 404 for non-existent workflow", async () => {
    const res = await request
      .put("/workflows/ffffffff-ffff-4fff-bfff-ffffffffffff")
      .set(AUTH)
      .send({ description: "test" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow not found");
  });
});

describe("POST /workflows/:id/validate", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockFetchSpecsForServices.mockClear();
  });

  it("validates the DAG of an existing workflow", async () => {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-1",
      workflowName: "Flow 1",
      workflowDynastySlug: "flow-1",
      workflowDynastyName: "Flow 1",
      version: 1,
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post(`/workflows/${WF_ID}/validate`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.invalidEndpoints).toEqual([]);
    expect(mockFetchSpecsForServices).toHaveBeenCalledTimes(1);
    expect(mockFetchSpecsForServices.mock.calls[0][0]).toEqual(["content-generation"]);
  });

  it("rejects when http.call references a path missing from the OpenAPI spec", async () => {
    const dagWithBadPath = {
      nodes: [
        {
          id: "gen",
          type: "http.call",
          config: { service: "content-generation", method: "POST", path: "/does-not-exist" },
          inputMapping: { "body.type": "cold-email" },
        },
      ],
      edges: [],
    };
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-bad",
      workflowName: "Bad",
      workflowDynastySlug: "flow-bad",
      workflowDynastyName: "Bad",
      version: 1,
      dag: dagWithBadPath,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post(`/workflows/${WF_ID}/validate`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.invalidEndpoints).toHaveLength(1);
    expect(res.body.invalidEndpoints[0].path).toBe("/does-not-exist");
  });

  it("rejects when http.call body is missing a required field", async () => {
    const dagMissingRequired = {
      nodes: [
        {
          id: "gen",
          type: "http.call",
          // Missing required `type` body field — content-generation spec requires it
          config: { service: "content-generation", method: "POST", path: "/generate" },
          inputMapping: { "body.variables.foo": "bar" },
        },
      ],
      edges: [],
    };
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-missing",
      workflowName: "Missing",
      workflowDynastySlug: "flow-missing",
      workflowDynastyName: "Missing",
      version: 1,
      dag: dagMissingRequired,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post(`/workflows/${WF_ID}/validate`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.fieldIssues.some((i: { severity: string; field: string }) =>
      i.severity === "error" && i.field === "type",
    )).toBe(true);
  });

  it("returns 500 when the API Registry is unreachable", async () => {
    mockFetchSpecsForServices.mockRejectedValueOnce(new Error("api-registry error: 503"));
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: "flow-down",
      workflowName: "Down",
      workflowDynastySlug: "flow-down",
      workflowDynastyName: "Down",
      version: 1,
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post(`/workflows/${WF_ID}/validate`)
      .set(AUTH);

    expect(res.status).toBe(500);
  });
});

describe("UUID validation on :id routes", () => {
  it("GET /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflows/new").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("GET /workflows/:id/required-providers returns 400 for non-UUID id", async () => {
    const res = await request.get("/workflows/new/required-providers").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("PUT /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.put("/workflows/not-a-uuid").set(AUTH).send({ description: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("DELETE /workflows/:id returns 400 for non-UUID id", async () => {
    const res = await request.delete("/workflows/abc").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });

  it("POST /workflows/:id/validate returns 400 for non-UUID id", async () => {
    const res = await request.post("/workflows/ranked/validate").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow ID format");
  });
});

// Every route that stores a client-supplied DAG runs the full gate, not just
// topology. Before this, only the LLM generation path resolved the target
// service's OpenAPI schema, which is how three workflows came to carry
// `"model": "deepseek-flash-v4"` — an alias content-generation does not accept,
// shape-valid, and rejected by the service on every call.
describe("client-supplied DAGs are validated against live endpoint schemas", () => {
  const dagWithModel = (model: string) => ({
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
  });

  const BAD = dagWithModel("deepseek-flash-v4");
  const GOOD = dagWithModel("deepseek-pro");

  const seedActiveRow = () => {
    mockDbRows.length = 0;
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "sales-cold-email-outreach-eden",
      workflowName: "Sales Cold Email Outreach Eden",
      workflowDynastySlug: "sales-cold-email-outreach-eden",
      workflowDynastyName: "Sales Cold Email Outreach Eden",
      workflowDynastySignatureName: "eden",
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      version: 1,
      status: "active",
      signature: "sig-existing",
      dag: VALID_LINEAR_DAG,
      tags: [],
      description: "existing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
  });

  it("POST /workflows rejects an invented model identifier", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      dag: BAD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DAG endpoint validation failed");
    expect(JSON.stringify(res.body.details)).toContain("deepseek-flash-v4");
  });

  it("POST /workflows accepts the same DAG once the model is a real alias", async () => {
    const res = await request.post("/workflows").set(AUTH).send({
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      dag: GOOD,
    });

    expect(res.status).toBe(201);
  });

  it("PUT /workflows/:id rejects an invented model identifier on the fork path", async () => {
    seedActiveRow();
    mockSelectResponses.push([mockDbRows[0]]);

    const res = await request.put(`/workflows/${WF_HTTP_ID}`).set(AUTH).send({ dag: BAD });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DAG endpoint validation failed");
  });

  it("POST /workflows/upgrade rejects an invented model identifier in a client-supplied dag", async () => {
    seedActiveRow();

    const res = await request.post("/workflows/upgrade").set(AUTH).send({
      workflowDynastySlug: "sales-cold-email-outreach-eden",
      dag: BAD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DAG endpoint validation failed");
  });
});

describe("POST /workflows/upgrade (workflowDynastySlug lookup)", () => {
  beforeEach(() => {
    mockDbRows.length = 0;
  });

  it("looks up the active row by dynastySlug regardless of which version is current", async () => {
    // Simulate dynasty 'eden' where v1, v2 are deprecated and v3 is active.
    // The route's WHERE filter is (workflowDynastySlug = ? AND status = 'active'),
    // so seeding only the active row mirrors what the DB would return.
    const signature = computeDAGSignature(VALID_LINEAR_DAG);
    mockDbRows.push({
      id: WF_HTTP_ID,
      orgId: "org-1",
      workflowSlug: "sales-cold-email-outreach-eden-v3",
      workflowName: "Sales Cold Email Outreach Eden v3",
      workflowDynastySlug: "sales-cold-email-outreach-eden",
      workflowDynastyName: "Sales Cold Email Outreach Eden",
      workflowDynastySignatureName: "eden",
      featureSlug: "sales-cold-email-outreach",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      version: 3,
      status: "active",
      signature,
      dag: VALID_LINEAR_DAG,
      tags: [],
      description: "v3 active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "sales-cold-email-outreach-eden",
        dag: VALID_LINEAR_DAG, // same signature -> in-place update (200)
      });

    expect(res.status).toBe(200);
    expect(res.body.workflow.workflowDynastySlug).toBe("sales-cold-email-outreach-eden");
    expect(res.body.workflow.version).toBe(3);
    expect(res.body.workflow.action).toBe("updated");
  });

  it("returns 404 when no active row matches the dynastySlug", async () => {
    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "no-such-dynasty",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("dynasty");
    expect(res.body.error).toContain("no-such-dynasty");
  });

  it("returns 409 (not a raw 500) when the new signature collides with another active workflow in the same feature_slug", async () => {
    // Bug 2 repro: upgrading dynasty A to a DAG whose signature already belongs to
    // an active sibling B (same feature_slug) used to leak the raw Postgres
    // idx_workflows_active_sig unique-constraint violation as a 500. The route must
    // detect the collision first and return a clean 409 naming the existing workflow.
    const newSignature = computeDAGSignature(VALID_LINEAR_DAG);

    // select #1 — dynasty lookup returns A (active, DIFFERENT signature → new-sig branch).
    // select #2 — conflict check returns B (active sibling already holding newSignature).
    mockSelectResponses.length = 0;
    mockSelectResponses.push([
      {
        id: WF_ID,
        orgId: "org-1",
        workflowSlug: "sales-cold-email-outreach-alcor-v2",
        workflowName: "Sales Cold Email Outreach Alcor v2",
        workflowDynastySlug: "sales-cold-email-outreach-alcor",
        workflowDynastyName: "Sales Cold Email Outreach Alcor",
        workflowDynastySignatureName: "alcor",
        featureSlug: "sales-cold-email-outreach",
        category: "sales",
        channel: "email",
        audienceType: "cold-outreach",
        version: 2,
        status: "active",
        signature: "signature-of-A-different-from-new",
        dag: VALID_LINEAR_DAG,
        tags: [],
        description: "A active",
        windmillFlowPath: "f/workflows/test/alcor",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockSelectResponses.push([
      {
        id: WF_EXISTING_ID,
        workflowSlug: "sales-cold-email-outreach-bellatrix",
        workflowName: "Sales Cold Email Outreach Bellatrix",
        signature: newSignature,
        status: "active",
        featureSlug: "sales-cold-email-outreach",
      },
    ]);

    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowDynastySlug: "sales-cold-email-outreach-alcor",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
    expect(res.body.existingWorkflowId).toBe(WF_EXISTING_ID);
    expect(res.body.existingWorkflowSlug).toBe("sales-cold-email-outreach-bellatrix");
    expect(res.body.existingWorkflowName).toBe("Sales Cold Email Outreach Bellatrix");
  });

  it("rejects legacy workflowSlug field with a Zod validation error (post-rename bigbang)", async () => {
    const res = await request
      .post("/workflows/upgrade")
      .set(AUTH)
      .send({
        workflowSlug: "sales-cold-email-outreach-eden",
        dag: VALID_LINEAR_DAG,
      });

    expect(res.status).toBe(400);
  });
});

describe("PUT /workflows/dynasty/:workflowDynastySlug/status", () => {
  const DYNASTY = "sales-cold-email-outreach-sequoia";

  beforeEach(() => {
    mockDbRows.length = 0;
    mockSelectResponses.length = 0;
    mockFetchProviderRequirements.mockReset();
    mockFetchProviderRequirements.mockResolvedValue({ requirements: [], providers: [] });
  });

  function pushDynastyRow(overrides: Record<string, unknown> = {}) {
    mockDbRows.push({
      id: WF_ID,
      orgId: "org-1",
      workflowSlug: DYNASTY,
      workflowName: "Sales Cold Email Outreach Sequoia",
      workflowDynastySlug: DYNASTY,
      workflowDynastyName: "Sales Cold Email Outreach Sequoia",
      featureSlug: "sales-cold-email-outreach",
      version: 1,
      status: "active",
      workflowDynastyStatus: "active",
      dag: VALID_LINEAR_DAG,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  it("deprecates a dynasty and returns the locked response shape", async () => {
    pushDynastyRow();

    const res = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "deprecated" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workflowDynastySlug: DYNASTY, status: "deprecated" });
  });

  it("round-trip: list reflects the dynasty status after deprecate then reactivate", async () => {
    pushDynastyRow();

    // Initially active
    let list = await request.get("/workflows").set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body.workflows[0].status).toBe("active");

    // Deprecate the dynasty
    const dep = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "deprecated" });
    expect(dep.status).toBe(200);

    list = await request.get("/workflows").set(AUTH);
    expect(list.body.workflows[0].status).toBe("deprecated");
    expect(list.body.workflows[0].workflowDynastyStatus).toBe("deprecated");

    // Reactivate
    const act = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "active" });
    expect(act.status).toBe(200);

    list = await request.get("/workflows").set(AUTH);
    expect(list.body.workflows[0].status).toBe("active");
    expect(list.body.workflows[0].workflowDynastyStatus).toBe("active");
  });

  it("is idempotent — re-applying the same status succeeds", async () => {
    pushDynastyRow({ workflowDynastyStatus: "deprecated" });

    const first = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "deprecated" });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("deprecated");

    const second = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "deprecated" });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("deprecated");
  });

  it("returns 404 for an unknown dynasty slug", async () => {
    const res = await request
      .put("/workflows/dynasty/does-not-exist/status")
      .set(AUTH)
      .send({ status: "deprecated" });

    expect(res.status).toBe(404);
  });

  it("rejects an invalid status value with 400", async () => {
    pushDynastyRow();

    const res = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(AUTH)
      .send({ status: "archived" });

    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request
      .put(`/workflows/dynasty/${DYNASTY}/status`)
      .set(IDENTITY)
      .send({ status: "deprecated" });

    expect(res.status).toBe(401);
  });
});
