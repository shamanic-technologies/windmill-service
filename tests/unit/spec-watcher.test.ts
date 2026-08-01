import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock API registry client
const mockFetchServiceList = vi.fn();
const mockFetchSpecsForServices = vi.fn();
vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchServiceList: (...args: unknown[]) => mockFetchServiceList(...args),
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
}));

// Mock startup-validator
const mockValidateAndUpgradeWorkflows = vi.fn();
vi.mock("../../src/lib/startup-validator.js", () => ({
  validateAndUpgradeWorkflows: (...args: unknown[]) => mockValidateAndUpgradeWorkflows(...args),
}));

import {
  SpecWatcher,
  setSpecWatcher,
  invalidateSpecWatcherCache,
} from "../../src/lib/spec-watcher.js";

// Minimal DAG with an http.call node
function makeDag(service: string, method: string, path: string) {
  return {
    nodes: [
      {
        id: "n1",
        type: "http.call",
        config: { service, method, path },
      },
    ],
    edges: [],
  };
}

// Minimal OpenAPI spec where GET /leads exists
function makeSpec(paths: Record<string, Record<string, unknown>>) {
  return { openapi: "3.0.0", paths };
}

// Fake DB that returns active workflows
function makeFakeDb(rows: unknown[]) {
  const selectResult = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(selectResult),
  } as unknown as Parameters<ConstructorParameters<typeof SpecWatcher>[0]["db"] extends never ? never : never>[0] & { select: ReturnType<typeof vi.fn> };
}

describe("SpecWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // By default, API Registry is reachable
    mockFetchServiceList.mockResolvedValue([{ service: "lead-service" }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips check cycle when API Registry is unreachable", async () => {
    mockFetchServiceList.mockRejectedValue(new Error("fetch failed"));

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag: makeDag("lead-service", "GET", "/leads"), status: "active" },
          ]),
        }),
      }),
    };

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });
    await watcher.check();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("API Registry unreachable"),
      expect.any(String),
    );
    // Must NOT proceed to fetch specs or trigger upgrades
    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("stores baseline hash on first check and does not trigger upgrade", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockResolvedValue(new Map([["lead-service", spec]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });
    await watcher.check();

    // Should NOT trigger upgrade on first check (baseline)
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("does not trigger upgrade when specs are unchanged", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockResolvedValue(new Map([["lead-service", spec]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // First check — store baseline
    await watcher.check();
    // Second check — same specs
    await watcher.check();

    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("logs warning when specs change AND workflow has issues (LLM upgrade disabled)", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");

    const specV1 = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });
    // V2: /leads endpoint removed — workflow will have issues
    const specV2 = makeSpec({ "/contacts": { get: { responses: { "200": {} } } } });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices
      .mockResolvedValueOnce(new Map([["lead-service", specV1]]))
      .mockResolvedValueOnce(new Map([["lead-service", specV2]]));

    const warnSpy = vi.spyOn(console, "warn");

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // First check — baseline
    await watcher.check();

    // Second check — specs changed, /leads is gone → workflow broken → log warning (no LLM)
    await watcher.check();
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LLM upgrade disabled"),
    );

    warnSpy.mockRestore();
  });

  it("does not trigger upgrade when specs change but workflows are still valid", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");

    const specV1 = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });
    // V2: /leads still exists, just added a new endpoint
    const specV2 = makeSpec({
      "/leads": { get: { responses: { "200": {} } } },
      "/leads/search": { post: { responses: { "200": {} } } },
    });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices
      .mockResolvedValueOnce(new Map([["lead-service", specV1]]))
      .mockResolvedValueOnce(new Map([["lead-service", specV2]]));

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    await watcher.check();
    await watcher.check();

    // Specs changed but workflow is still valid — no upgrade
    expect(mockValidateAndUpgradeWorkflows).not.toHaveBeenCalled();
  });

  it("skips check if no active workflows", async () => {
    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });
    await watcher.check();

    expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
  });

  it("does not run concurrent checks", async () => {
    const dag = makeDag("lead-service", "GET", "/leads");
    const spec = makeSpec({ "/leads": { get: { responses: { "200": {} } } } });

    // Make the fetch hang until we resolve it
    let resolveSpecs!: (v: Map<string, unknown>) => void;
    const hangingPromise = new Promise<Map<string, unknown>>((r) => { resolveSpecs = r; });

    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "w1", workflowSlug: "test-wf", dag, status: "active" },
          ]),
        }),
      }),
    };

    mockFetchSpecsForServices.mockReturnValue(hangingPromise);

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    // Start first check (will hang on fetchSpecsForServices)
    const p1 = watcher.check();
    // Start second check — should skip
    const p2 = watcher.check();

    // Resolve the hanging fetch
    resolveSpecs(new Map([["lead-service", spec]]));
    await p1;
    await p2;

    // Only one call to fetchSpecsForServices (the second check was skipped)
    expect(mockFetchSpecsForServices).toHaveBeenCalledTimes(1);
  });

  it("start() and stop() manage the interval", () => {
    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    const watcher = new SpecWatcher({ db: fakeDb as any, windmillClient: null });

    vi.useFakeTimers();
    watcher.start();
    watcher.stop();
    vi.useRealTimers();

    // No error, no hanging timers
  });

  /**
   * Scale-to-zero regression guard. The compute suspends after 300s of no
   * activity, so an hourly tick that opens with a `SELECT` resets that timer 24
   * times a day and the whole billing period is charged as active. The service
   * set is cached in memory precisely so a no-drift tick issues no query.
   */
  describe("does not touch the database on a quiet tick", () => {
    const dag = makeDag("lead-service", "get", "/leads");
    const spec = makeSpec({ "/leads": { get: {} } });

    function watcherWithOneWorkflow() {
      const fakeDb = makeFakeDb([{ workflowSlug: "wf-1", dag }]);
      mockFetchSpecsForServices.mockResolvedValue(new Map([["lead-service", spec]]));
      return {
        fakeDb,
        watcher: new SpecWatcher({ db: fakeDb as never, windmillClient: null }),
      };
    }

    it("reads the workflows once to prime the cache, then never again while specs are stable", async () => {
      const { fakeDb, watcher } = watcherWithOneWorkflow();

      await watcher.check(); // boot: primes cache + baseline hash
      expect(fakeDb.select).toHaveBeenCalledTimes(1);

      // Every subsequent tick with unchanged specs must be HTTP-only.
      await watcher.check();
      await watcher.check();
      await watcher.check();

      expect(fakeDb.select).toHaveBeenCalledTimes(1);
      // ...while still genuinely re-checking the specs each time.
      expect(mockFetchSpecsForServices).toHaveBeenCalledTimes(4);
    });

    it("reads the workflows again when the specs actually drift", async () => {
      const { fakeDb, watcher } = watcherWithOneWorkflow();

      await watcher.check();
      expect(fakeDb.select).toHaveBeenCalledTimes(1);

      // Same services, different spec content → hash moves → DAGs are needed.
      mockFetchSpecsForServices.mockResolvedValue(
        new Map([["lead-service", makeSpec({ "/leads": { get: {}, post: {} } })]]),
      );
      await watcher.check();

      expect(fakeDb.select).toHaveBeenCalledTimes(2);
    });

    it("re-reads the workflows after a write invalidates the cache", async () => {
      const { fakeDb, watcher } = watcherWithOneWorkflow();

      await watcher.check();
      await watcher.check();
      expect(fakeDb.select).toHaveBeenCalledTimes(1);

      // A workflow write can reference a service nobody called before.
      watcher.invalidateWorkflowCache();
      await watcher.check();

      expect(fakeDb.select).toHaveBeenCalledTimes(2);
    });

    it("does not query on a tick when no workflow is active", async () => {
      const fakeDb = makeFakeDb([]);
      const watcher = new SpecWatcher({ db: fakeDb as never, windmillClient: null });

      await watcher.check();
      await watcher.check();
      await watcher.check();

      // One read to learn there is nothing, and no spec fetch at all.
      expect(fakeDb.select).toHaveBeenCalledTimes(1);
      expect(mockFetchSpecsForServices).not.toHaveBeenCalled();
    });

    it("invalidateSpecWatcherCache is a safe no-op when no watcher is registered", () => {
      setSpecWatcher(null);
      expect(() => invalidateSpecWatcherCache()).not.toThrow();
    });

    it("invalidateSpecWatcherCache drives the registered watcher", async () => {
      const { fakeDb, watcher } = watcherWithOneWorkflow();
      setSpecWatcher(watcher);

      await watcher.check();
      await watcher.check();
      expect(fakeDb.select).toHaveBeenCalledTimes(1);

      invalidateSpecWatcherCache();
      await watcher.check();
      expect(fakeDb.select).toHaveBeenCalledTimes(2);

      setSpecWatcher(null);
    });
  });
});
