import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/lib/stale-workflow-deprecator.js", () => ({
  deprecateStaleWorkflows: vi.fn(),
}));

vi.mock("../../src/lib/windmill-flow-cleanup.js", () => ({
  cleanupOrphanedWindmillFlows: vi.fn(),
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchActiveWorkflowSlugs: vi.fn(),
}));

import {
  PeriodicCleanup,
  setPeriodicCleanup,
  noteWorkflowWrite,
} from "../../src/lib/periodic-cleanup.js";
import { deprecateStaleWorkflows } from "../../src/lib/stale-workflow-deprecator.js";
import { cleanupOrphanedWindmillFlows } from "../../src/lib/windmill-flow-cleanup.js";
import { fetchActiveWorkflowSlugs } from "../../src/lib/campaign-client.js";

const deprecateMock = vi.mocked(deprecateStaleWorkflows);
const cleanupMock = vi.mocked(cleanupOrphanedWindmillFlows);
const fetchSlugsMock = vi.mocked(fetchActiveWorkflowSlugs);

describe("PeriodicCleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * The sweep rides write traffic instead of a timer: a 24h `setInterval` wakes
   * the Neon compute to collect nothing on a quiet service, and a woken compute
   * bills for a full idle timeout.
   */
  function okSweep() {
    deprecateMock.mockResolvedValue({
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: false,
    });
    fetchSlugsMock.mockResolvedValue(new Set<string>());
    cleanupMock.mockResolvedValue({ deleted: 0, kept: 0, failed: 0 });
  }

  it("schedules no timer of its own", () => {
    vi.useFakeTimers();
    new PeriodicCleanup({} as never, {} as never, 60_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("maybeRun does not sweep before minIntervalMs has elapsed", () => {
    okSweep();
    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    // Boot already swept, so the clock starts at construction.
    cleanup.maybeRun();
    cleanup.maybeRun();

    expect(deprecateMock).not.toHaveBeenCalled();
  });

  it("maybeRun sweeps once minIntervalMs has elapsed, then rate-limits again", async () => {
    vi.useFakeTimers();
    okSweep();
    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    await vi.advanceTimersByTimeAsync(60_001);
    cleanup.maybeRun();
    // Let the sweep settle so `inFlight` clears.
    await vi.advanceTimersByTimeAsync(0);
    expect(deprecateMock).toHaveBeenCalledTimes(1);

    // A burst of writes right after must not sweep again.
    cleanup.maybeRun();
    cleanup.maybeRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(deprecateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    cleanup.maybeRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(deprecateMock).toHaveBeenCalledTimes(2);
  });

  it("a failing sweep still advances the clock — one bad sweep must not wedge the gate", async () => {
    vi.useFakeTimers();
    deprecateMock.mockRejectedValue(new Error("db blew up"));
    fetchSlugsMock.mockResolvedValue(new Set<string>());
    cleanupMock.mockResolvedValue({ deleted: 0, kept: 0, failed: 0 });
    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    vi.advanceTimersByTime(60_001);
    cleanup.maybeRun();
    await vi.waitFor(() => expect(deprecateMock).toHaveBeenCalledTimes(1));

    cleanup.maybeRun();
    expect(deprecateMock).toHaveBeenCalledTimes(1);
  });

  it("noteWorkflowWrite is a safe no-op when no cleanup is registered", () => {
    setPeriodicCleanup(null);
    expect(() => noteWorkflowWrite()).not.toThrow();
  });

  it("noteWorkflowWrite drives the registered cleanup", async () => {
    vi.useFakeTimers();
    okSweep();
    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);
    setPeriodicCleanup(cleanup);

    vi.advanceTimersByTime(60_001);
    noteWorkflowWrite();
    await vi.waitFor(() => expect(deprecateMock).toHaveBeenCalledTimes(1));

    setPeriodicCleanup(null);
  });

  it("runOnce calls deprecateStaleWorkflows then cleanupOrphanedWindmillFlows with fetched slugs", async () => {
    deprecateMock.mockResolvedValueOnce({
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: false,
    });
    fetchSlugsMock.mockResolvedValueOnce(new Set(["active-slug"]));
    cleanupMock.mockResolvedValueOnce({ deleted: 0, kept: 0, failed: 0 });

    const db = { tag: "db" } as never;
    const windmillClient = { tag: "wm" } as never;
    const cleanup = new PeriodicCleanup(db, windmillClient, 60_000);

    await cleanup.runOnce();

    expect(deprecateMock).toHaveBeenCalledWith(db);
    expect(fetchSlugsMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(db, windmillClient, new Set(["active-slug"]));

    const deprecateOrder = deprecateMock.mock.invocationCallOrder[0];
    const cleanupOrder = cleanupMock.mock.invocationCallOrder[0];
    expect(deprecateOrder).toBeLessThan(cleanupOrder);
  });

  it("skips cleanupOrphanedWindmillFlows when fetchActiveWorkflowSlugs throws", async () => {
    deprecateMock.mockResolvedValueOnce({
      deprecatedCount: 0,
      keptByCampaign: 0,
      skippedNoCampaignService: false,
    });
    fetchSlugsMock.mockRejectedValueOnce(new Error("campaign-service down"));

    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    await expect(cleanup.runOnce()).resolves.toBeUndefined();
    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it("continues if deprecateStaleWorkflows throws — still attempts cleanup", async () => {
    deprecateMock.mockRejectedValueOnce(new Error("db blew up"));
    fetchSlugsMock.mockResolvedValueOnce(new Set());
    cleanupMock.mockResolvedValueOnce({ deleted: 0, kept: 0, failed: 0 });

    const cleanup = new PeriodicCleanup({} as never, {} as never, 60_000);

    await expect(cleanup.runOnce()).resolves.toBeUndefined();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });
});
