import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals, op: "inArray" })),
}));

vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

const mockCloseRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
}));

const mockTraceEvent = vi.fn(() => Promise.resolve());
vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: (...args: unknown[]) => mockTraceEvent(...args),
}));

import { JobPoller, UNRESOLVABLE_JOB_POLL_ATTEMPTS } from "../../src/lib/job-poller.js";
import { WindmillApiError, isUnresolvableWindmillJobError } from "../../src/lib/windmill-client.js";

/**
 * The production incident this guards: a workflow was upgraded while one of its
 * jobs was in flight, so Windmill lost the flow node the job referenced and
 * answered 500 "Flow node not found" for it forever. The poller only logged, so
 * the run stayed `queued`, kept holding its `execution_key`, and every later
 * execute for that campaign deduped onto it — the campaign could never run again.
 */
describe("JobPoller: permanently unresolvable Windmill jobs", () => {
  let dbSetCalls: Array<Record<string, unknown>>;

  function createMockDb(runs: Array<Record<string, unknown>>) {
    dbSetCalls = [];
    return {
      select: () => ({ from: () => ({ where: () => Promise.resolve(runs) }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          dbSetCalls.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
    };
  }

  const mockTable = { status: "status", id: "id" };

  const flowNodeNotFound = () =>
    new WindmillApiError(
      500,
      "GET",
      "/jobs_u/get/01a07173-1d45-d932-d980-5de3073e26e1",
      "Internal: windmill-common/src/cache.rs: Flow node not found",
      'Windmill API error: GET /jobs_u/get/01a07173 → 500 Internal Server Error: Internal: windmill-common/src/cache.rs: Flow node not found',
    );

  beforeEach(() => {
    mockCloseRun.mockReset();
    mockCloseRun.mockResolvedValue(undefined);
    mockTraceEvent.mockClear();
  });

  it("classifies the incident's error as unresolvable, and a plain 5xx as transient", () => {
    expect(isUnresolvableWindmillJobError(flowNodeNotFound())).toBe(true);
    expect(
      isUnresolvableWindmillJobError(
        new WindmillApiError(404, "GET", "/jobs_u/get/x", "Not found: job", "404"),
      ),
    ).toBe(true);
    expect(
      isUnresolvableWindmillJobError(
        new WindmillApiError(502, "GET", "/jobs_u/get/x", "Bad Gateway", "502"),
      ),
    ).toBe(false);
    expect(isUnresolvableWindmillJobError(new Error("fetch failed"))).toBe(false);
  });

  it("does not fail the run on the first unresolvable poll", async () => {
    const runs = [{ id: "run-1", windmillJobId: "job-1", status: "queued", runId: "r1", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const client = { getJob: vi.fn().mockRejectedValue(flowNodeNotFound()) } as any;
    const poller = new JobPoller(mockDb, client, mockTable, 60_000);
    const poll = (poller as any).poll.bind(poller);

    await poll();

    expect(dbSetCalls.length).toBe(0);
    expect(mockCloseRun).not.toHaveBeenCalled();
  });

  it("fails the run after consecutive unresolvable polls so it releases its execution key", async () => {
    const runs = [{
      id: "6944ae0a-8a8a-419f-b807-bc52e54c0736",
      windmillJobId: "01a07173-1d45-d932-d980-5de3073e26e1",
      status: "queued",
      runId: "runs-svc-1",
      orgId: "org-1",
      workflowSlug: "ai-meeting-booking-rhodium",
      executionKey: "campaign:abc",
      conflictPolicy: "use_existing",
    }];
    const mockDb = createMockDb(runs);
    const client = { getJob: vi.fn().mockRejectedValue(flowNodeNotFound()) } as any;
    const poller = new JobPoller(mockDb, client, mockTable, 60_000);
    const poll = (poller as any).poll.bind(poller);

    for (let i = 0; i < UNRESOLVABLE_JOB_POLL_ATTEMPTS; i++) await poll();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].status).toBe("failed");
    expect(dbSetCalls[0].completedAt).toBeInstanceOf(Date);
    expect(String(dbSetCalls[0].error)).toContain("unresolvable");
    expect(String(dbSetCalls[0].error)).toContain("Flow node not found");
    expect(mockCloseRun).toHaveBeenCalledWith("runs-svc-1", "failed", "org-1");
    expect(mockTraceEvent).toHaveBeenCalledWith(
      "runs-svc-1",
      expect.objectContaining({ event: "job-unresolvable", level: "error" }),
      expect.any(Object),
    );
  });

  it("never marks an unresolvable run completed", async () => {
    const runs = [{ id: "run-2", windmillJobId: "job-2", status: "running", runId: "r2", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const client = { getJob: vi.fn().mockRejectedValue(flowNodeNotFound()) } as any;
    const poller = new JobPoller(mockDb, client, mockTable, 60_000);
    const poll = (poller as any).poll.bind(poller);

    for (let i = 0; i < UNRESOLVABLE_JOB_POLL_ATTEMPTS + 2; i++) await poll();

    for (const call of dbSetCalls) expect(call.status).not.toBe("completed");
    expect(mockCloseRun).not.toHaveBeenCalledWith(expect.anything(), "completed", expect.anything());
  });

  it("keeps retrying a transient failure and still recovers when it clears", async () => {
    const runs = [{ id: "run-3", windmillJobId: "job-3", status: "running", runId: "r3", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const getJob = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new WindmillApiError(503, "GET", "/jobs_u/get/job-3", "Service Unavailable", "503"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue({ running: false, success: true, result: { ok: true } });
    const poller = new JobPoller(mockDb, { getJob } as any, mockTable, 60_000);
    const poll = (poller as any).poll.bind(poller);

    for (let i = 0; i < 4; i++) await poll();

    expect(dbSetCalls.length).toBe(1);
    expect(dbSetCalls[0].status).toBe("completed");
    expect(mockCloseRun).toHaveBeenCalledWith("r3", "completed", "org-1");
  });

  it("resets the streak when a transient failure interrupts unresolvable polls", async () => {
    const runs = [{ id: "run-4", windmillJobId: "job-4", status: "running", runId: "r4", orgId: "org-1" }];
    const mockDb = createMockDb(runs);
    const getJob = vi.fn()
      .mockRejectedValueOnce(flowNodeNotFound())
      .mockRejectedValueOnce(flowNodeNotFound())
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(flowNodeNotFound())
      .mockRejectedValueOnce(flowNodeNotFound());
    const poller = new JobPoller(mockDb, { getJob } as any, mockTable, 60_000);
    const poll = (poller as any).poll.bind(poller);

    for (let i = 0; i < 5; i++) await poll();

    expect(dbSetCalls.length).toBe(0);
  });
});
