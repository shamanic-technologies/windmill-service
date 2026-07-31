import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals, op: "inArray" })),
}));

vi.mock("../../src/db/index.js", () => ({
  db: "mock-db",
  sql: { end: () => Promise.resolve() },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  closeRun: vi.fn(),
}));

import {
  JobPoller,
  setJobPoller,
  getJobPoller,
  wakeJobPoller,
} from "../../src/lib/job-poller.js";

/**
 * The poller must not hold the Neon compute open when there is nothing to
 * reconcile — an unconditional SELECT every 10s means the compute never reaches
 * its idle timeout and scale-to-zero saves nothing.
 */
describe("JobPoller idles when there is no work", () => {
  let selectCount: number;
  let activeRuns: Array<Record<string, unknown>>;
  let onQuery: (() => void) | null;

  function createMockDb() {
    return {
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            onQuery?.();
            return Promise.resolve(activeRuns);
          },
        }),
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve() }),
      }),
    };
  }

  const windmill = { getJob: vi.fn() } as never;

  beforeEach(() => {
    vi.useFakeTimers();
    selectCount = 0;
    activeRuns = [];
    onQuery = null;
    setJobPoller(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setJobPoller(null);
  });

  it("stops polling after a tick that finds no queued or running run", async () => {
    const poller = new JobPoller(createMockDb(), windmill, {}, 10_000);
    poller.start();
    expect(poller.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(selectCount).toBe(1);
    expect(poller.isRunning()).toBe(false);

    // The compute is now free to suspend: no further queries, ever.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(selectCount).toBe(1);
  });

  it("keeps polling while runs are outstanding", async () => {
    activeRuns = [{ id: "r1", status: "running", windmillJobId: null }];
    const poller = new JobPoller(createMockDb(), windmill, {}, 10_000);
    poller.start();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(selectCount).toBe(3);
    expect(poller.isRunning()).toBe(true);
  });

  it("wake() restarts an idled poller", async () => {
    const poller = new JobPoller(createMockDb(), windmill, {}, 10_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poller.isRunning()).toBe(false);

    activeRuns = [{ id: "r1", status: "queued", windmillJobId: null }];
    poller.wake();
    expect(poller.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(selectCount).toBe(2);
    expect(poller.isRunning()).toBe(true);
  });

  it("does not swallow a wake that lands mid-poll", async () => {
    const poller = new JobPoller(createMockDb(), windmill, {}, 10_000);
    poller.start();

    // A run is dispatched after the SELECT has already returned empty. Without
    // the woken-during-poll guard the poller would idle and never reconcile it.
    onQuery = () => {
      activeRuns = [{ id: "r1", status: "queued", windmillJobId: null }];
      poller.wake();
    };

    await vi.advanceTimersByTimeAsync(10_000);

    expect(poller.isRunning()).toBe(true);
  });

  it("wake() is idempotent while already polling", () => {
    const poller = new JobPoller(createMockDb(), windmill, {}, 10_000);
    poller.start();
    poller.wake();
    poller.wake();
    expect(poller.isRunning()).toBe(true);
  });
});

describe("shared poller handle", () => {
  beforeEach(() => setJobPoller(null));
  afterEach(() => setJobPoller(null));

  it("wakeJobPoller() is a no-op when Windmill is not configured", () => {
    expect(getJobPoller()).toBeNull();
    expect(() => wakeJobPoller()).not.toThrow();
  });

  it("wakeJobPoller() wakes the registered poller", () => {
    const wake = vi.fn();
    setJobPoller({ wake } as unknown as JobPoller);

    wakeJobPoller();

    expect(wake).toHaveBeenCalledTimes(1);
  });
});
