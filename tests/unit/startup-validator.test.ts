import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock API registry client
const mockFetchServiceList = vi.fn();
const mockFetchSpecsForServices = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchServiceList: (...args: unknown[]) => mockFetchServiceList(...args),
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
  fetchLlmContext: vi.fn().mockResolvedValue({ services: [] }),
  fetchServiceSpec: vi.fn().mockResolvedValue({}),
}));

// Mock upgrader
const mockUpgradeWorkflow = vi.fn();
vi.mock("../../src/lib/workflow-upgrader.js", () => ({
  upgradeWorkflow: (...args: unknown[]) => mockUpgradeWorkflow(...args),
}));

// Mock key-service client
const mockFetchPlatformAnthropicKey = vi.fn();
vi.mock("../../src/lib/key-service-client.js", () => ({
  fetchPlatformAnthropicKey: (...args: unknown[]) => mockFetchPlatformAnthropicKey(...args),
}));

// Mock runs-client
const mockCreatePlatformRun = vi.fn();
const mockClosePlatformRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createPlatformRun: (...args: unknown[]) => mockCreatePlatformRun(...args),
  closePlatformRun: (...args: unknown[]) => mockClosePlatformRun(...args),
}));

// Mock dag-to-openflow
vi.mock("../../src/lib/dag-to-openflow.js", () => ({
  dagToOpenFlow: vi.fn().mockReturnValue({
    value: { modules: [], same_worker: false },
    schema: {},
  }),
}));

// Mock dag-signature
vi.mock("../../src/lib/dag-signature.js", () => ({
  computeDAGSignature: vi.fn().mockReturnValue("new-signature-hash"),
}));

// Mock signature-words
vi.mock("../../src/lib/signature-words.js", () => ({
  pickSignatureName: vi.fn().mockReturnValue("Redwood"),
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

import {
  checkApiRegistryHealth,
  validateAndUpgradeWorkflows,
} from "../../src/lib/startup-validator.js";

describe("checkApiRegistryHealth", () => {
  beforeEach(() => {
    mockFetchServiceList.mockReset();
  });

  it("succeeds when API Registry is reachable", async () => {
    mockFetchServiceList.mockResolvedValue([{ service: "campaign" }]);
    await expect(checkApiRegistryHealth()).resolves.toBeUndefined();
    expect(mockFetchServiceList).toHaveBeenCalledTimes(1);
    // Should be called without identity
    expect(mockFetchServiceList).toHaveBeenCalledWith();
  });

  it("throws when API Registry is unreachable", async () => {
    mockFetchServiceList.mockRejectedValue(new Error("Connection refused"));
    await expect(checkApiRegistryHealth()).rejects.toThrow("Connection refused");
  });
});

describe("validateAndUpgradeWorkflows", () => {
  const VALID_WORKFLOW = {
    id: "wf-1",
    orgId: "org-1",
    name: "sales-email-cold-outreach-Sequoia",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    description: "Test",
    status: "active",
    signature: "sig-1",
    signatureName: "Sequoia",
    windmillWorkspace: "prod",
    windmillFlowPath: "f/workflows/org-1/flow",
    dag: {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    },
    tags: [],
    brandId: null,
    humanId: null,
    campaignId: null,
    subrequestId: null,
    styleName: null,
    displayName: null,
    upgradedTo: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const BROKEN_WORKFLOW = {
    ...VALID_WORKFLOW,
    id: "wf-2",
    name: "sales-email-cold-outreach-Broken",
    signatureName: "Broken",
    dag: {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/internal/gate-check" },
        },
      ],
      edges: [],
    },
  };

  const CAMPAIGN_SPEC = {
    paths: {
      "/gate-check": { post: {} },
      "/start-run": { post: {} },
      "/end-run": { post: {} },
    },
  };

  // Build a mock database that tracks operations
  let dbSelectResult: Record<string, unknown>[] = [];
  let dbUpdates: Array<{ values: Record<string, unknown>; id: string }> = [];
  let dbInserts: Record<string, unknown>[] = [];

  let selectCallCount = 0;

  function createMockDb() {
    selectCallCount = 0;
    return {
      select: () => ({
        from: () => {
          selectCallCount++;
          const currentCount = selectCallCount;

          const getData = () => {
            if (currentCount === 1) {
              return Promise.resolve(dbSelectResult);
            }
            return Promise.resolve(
              dbSelectResult.map((r) => ({ signatureName: (r as Record<string, unknown>).signatureName })),
            );
          };

          // Return a thenable with .where() — supports both `await db.select().from()` and `.from().where()`
          const promise = getData();
          (promise as any).where = () => getData();
          return promise;
        },
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          const newRow = {
            id: "wf-new-" + Math.random().toString(36).slice(2, 8),
            ...row,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbInserts.push(newRow);
          return { returning: () => Promise.resolve([newRow]) };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            dbUpdates.push({ values, id: "unknown" });
            return { returning: () => Promise.resolve([]) };
          },
        }),
      }),
    };
  }

  beforeEach(() => {
    mockFetchSpecsForServices.mockReset();
    mockUpgradeWorkflow.mockReset();
    mockFetchPlatformAnthropicKey.mockReset();
    mockCreatePlatformRun.mockReset();
    mockClosePlatformRun.mockReset();
    dbSelectResult = [];
    dbUpdates = [];
    dbInserts = [];
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
  });

  it("logs success when all workflows are valid", async () => {
    dbSelectResult = [VALID_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 valid"),
    );
    consoleSpy.mockRestore();
  });

  it("deprecates broken workflow when platform key not available", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockRejectedValue(new Error("key not found"));

    const consoleSpy = vi.spyOn(console, "warn");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should have called update to deprecate
    expect(dbUpdates.length).toBeGreaterThan(0);
    expect(dbUpdates[0].values).toMatchObject({
      status: "deprecated",
      upgradedTo: null,
    });

    consoleSpy.mockRestore();
  });

  it("upgrades broken workflow using platform key and tracks run", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-platform-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "platform-run-123" });
    mockClosePlatformRun.mockResolvedValue(undefined);

    const fixedDag = {
      nodes: [
        {
          id: "gate-check",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/gate-check" },
        },
      ],
      edges: [],
    };

    mockUpgradeWorkflow.mockResolvedValue({
      dag: fixedDag,
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Fixed workflow",
    });

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should have resolved the key via platform endpoint
    expect(mockFetchPlatformAnthropicKey).toHaveBeenCalledTimes(1);

    // Should have created a platform run
    expect(mockCreatePlatformRun).toHaveBeenCalledWith({
      serviceName: "workflow",
      taskName: "startup-upgrade",
      workflowName: "sales-email-cold-outreach-Broken",
    });

    // Should have called upgradeWorkflow with the platform key and no identity
    expect(mockUpgradeWorkflow).toHaveBeenCalledWith(
      BROKEN_WORKFLOW.dag,
      expect.any(Array),
      "test-platform-key",
      undefined,
      expect.objectContaining({ category: "sales" }),
    );

    // Should have inserted a new workflow
    expect(dbInserts.length).toBe(1);
    expect(dbInserts[0].status).toBe("active");
    expect(dbInserts[0].createdByUserId).toBe("workflow-service");
    expect(dbInserts[0].createdByRunId).toBe("platform-run-123");

    // Should have deprecated the old workflow
    expect(dbUpdates.length).toBeGreaterThan(0);
    expect(dbUpdates[0].values.status).toBe("deprecated");

    // Should have closed the platform run as completed
    expect(mockClosePlatformRun).toHaveBeenCalledWith("platform-run-123", "completed");
  });

  it("handles empty workflow list gracefully", async () => {
    dbSelectResult = [];

    const consoleSpy = vi.spyOn(console, "log");

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[startup] No active workflows to validate",
    );
    consoleSpy.mockRestore();
  });

  it("closes platform run as failed when upgrade throws", async () => {
    dbSelectResult = [BROKEN_WORKFLOW];
    mockFetchSpecsForServices.mockResolvedValue(
      new Map([["campaign", CAMPAIGN_SPEC]]),
    );
    mockFetchPlatformAnthropicKey.mockResolvedValue({ key: "test-key", keySource: "platform" });
    mockCreatePlatformRun.mockResolvedValue({ runId: "platform-run-456" });
    mockClosePlatformRun.mockResolvedValue(undefined);
    mockUpgradeWorkflow.mockRejectedValue(new Error("LLM error"));

    await validateAndUpgradeWorkflows({
      db: createMockDb() as any,
      windmillClient: null,
    });

    // Should have closed the platform run as failed
    expect(mockClosePlatformRun).toHaveBeenCalledWith("platform-run-456", "failed");

    // Should have deprecated the workflow
    expect(dbUpdates.length).toBeGreaterThan(0);
    expect(dbUpdates[0].values.status).toBe("deprecated");
  });
});
