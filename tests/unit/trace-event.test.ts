import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { traceEvent } from "../../src/lib/trace-event.js";

describe("traceEvent", () => {
  const originalUrl = process.env.RUNS_SERVICE_URL;
  const originalKey = process.env.RUNS_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://localhost:5000";
    process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
  });

  afterEach(() => {
    process.env.RUNS_SERVICE_URL = originalUrl;
    process.env.RUNS_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/runs/{runId}/events with payload and forwarded headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-123",
      {
        service: "workflow-service",
        event: "execute",
        detail: "Starting workflow execution for slug=test-workflow",
        level: "info",
        data: { slug: "test-workflow" },
      },
      {
        "x-org-id": "org-1",
        "x-user-id": "user-1",
        "x-brand-id": "brand-1,brand-2",
        "x-campaign-id": "camp-1",
        "x-workflow-slug": "test-workflow",
        "x-feature-slug": "cold-outreach",
        "x-goal": "signup",
        "x-brand-profile-id": "brand-profile-real-1",
        "x-customer-persona-id": "customer-persona-real-1",
        "x-customer-profile-id": "customer-profile-real-1",
        "x-profile-id": "profile-real-1",
        "x-persona-id": "persona-real-1",
        "x-goal-id": "goal-real-1",
        "x-goal-slug": "signups",
        "x-optimization-goal": "signups",
      }
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs/run-123/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-runs-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-brand-id": "brand-1,brand-2",
          "x-campaign-id": "camp-1",
          "x-workflow-slug": "test-workflow",
          "x-feature-slug": "cold-outreach",
          "x-goal": "signup",
          "x-brand-profile-id": "brand-profile-real-1",
          "x-customer-persona-id": "customer-persona-real-1",
          "x-customer-profile-id": "customer-profile-real-1",
          "x-profile-id": "profile-real-1",
          "x-persona-id": "persona-real-1",
          "x-goal-id": "goal-real-1",
          "x-goal-slug": "signups",
          "x-optimization-goal": "signups",
        }),
        body: JSON.stringify({
          service: "workflow-service",
          event: "execute",
          detail: "Starting workflow execution for slug=test-workflow",
          level: "info",
          data: { slug: "test-workflow" },
        }),
      })
    );
  });

  it("skips when RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());

    await traceEvent(
      "run-123",
      { service: "workflow-service", event: "test" },
      {}
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set")
    );
  });

  it("skips when RUNS_SERVICE_API_KEY is not set", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());

    await traceEvent(
      "run-123",
      { service: "workflow-service", event: "test" },
      {}
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set")
    );
  });

  it("swallows fetch errors without throwing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );

    await expect(
      traceEvent(
        "run-123",
        { service: "workflow-service", event: "test" },
        {}
      )
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[workflow-service] Failed to trace event:",
      expect.any(Error)
    );
  });

  it("does not throw when fetch returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    await expect(
      traceEvent("run-500", { service: "workflow-service", event: "test" }, {})
    ).resolves.toBeUndefined();
  });

  it("only forwards headers that exist (omits missing ones)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-123",
      { service: "workflow-service", event: "test" },
      { "x-org-id": "org-1" }
    );

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders["x-org-id"]).toBe("org-1");
    expect(calledHeaders).not.toHaveProperty("x-user-id");
    expect(calledHeaders).not.toHaveProperty("x-brand-id");
    expect(calledHeaders).not.toHaveProperty("x-campaign-id");
    expect(calledHeaders).not.toHaveProperty("x-workflow-slug");
    expect(calledHeaders).not.toHaveProperty("x-feature-slug");
  });

  it("strips trailing slash from RUNS_SERVICE_URL", async () => {
    process.env.RUNS_SERVICE_URL = "http://localhost:5000/";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await traceEvent(
      "run-456",
      { service: "workflow-service", event: "test" },
      {}
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs/run-456/events",
      expect.anything()
    );
  });
});
