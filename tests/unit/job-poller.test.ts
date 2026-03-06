import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to mock drizzle operators since they're used internally
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals, op: "inArray" })),
}));

vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

import { JobPoller } from "../../src/lib/job-poller.js";

describe("JobPoller error serialization", () => {
  let dbSetCalls: Array<Record<string, unknown>>;
  let mockGetJob: ReturnType<typeof vi.fn>;

  function createMockDb(runs: Array<Record<string, unknown>>) {
    dbSetCalls = [];
    return {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(runs),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          dbSetCalls.push(values);
          return {
            where: () => Promise.resolve(),
          };
        },
      }),
    };
  }

  function createMockWindmillClient() {
    mockGetJob = vi.fn();
    return { getJob: mockGetJob } as any;
  }

  const mockTable = {
    status: "status",
    id: "id",
  };

  beforeEach(() => {
    dbSetCalls = [];
  });

  it("serializes object errors as JSON instead of [object Object]", async () => {
    const errorResult = { message: "Node gate-check failed", code: 500, details: { step: "gate-check" } };
    const runs = [{ id: "run-1", windmillJobId: "job-1", status: "running" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ running: false, success: false, result: errorResult });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);

    // Directly call the private poll method via start + immediate trigger
    // Instead, we access poll directly for testing
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].status).toBe("failed");
    expect(dbSetCalls[0].error).toBe(JSON.stringify(errorResult));
    // Must NOT be [object Object]
    expect(dbSetCalls[0].error).not.toBe("[object Object]");
  });

  it("preserves string errors as-is", async () => {
    const runs = [{ id: "run-2", windmillJobId: "job-2", status: "running" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ running: false, success: false, result: "Simple error message" });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].error).toBe("Simple error message");
  });

  it("handles null/undefined error results", async () => {
    const runs = [{ id: "run-3", windmillJobId: "job-3", status: "queued" }];
    const mockDb = createMockDb(runs);
    const mockClient = createMockWindmillClient();
    mockGetJob.mockResolvedValue({ running: false, success: false, result: null });

    const poller = new JobPoller(mockDb, mockClient, mockTable, 60_000);
    const pollMethod = (poller as any).poll.bind(poller);
    await pollMethod();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].error).toBe('"Unknown error"');
  });
});
