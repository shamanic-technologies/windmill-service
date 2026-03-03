import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRun } from "../../src/lib/runs-client.js";

describe("createRun", () => {
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

  it("calls POST /runs/start with parentRunId, orgId, userId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: "new-run-123" }),
      })
    );

    const result = await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({ runId: "new-run-123" });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/runs/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-runs-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "caller-run-1",
        }),
        body: JSON.stringify({
          parentRunId: "caller-run-1",
          service: "workflow",
          orgId: "org-1",
          userId: "user-1",
        }),
      })
    );
  });

  it("strips trailing slash from RUNS_SERVICE_URL", async () => {
    process.env.RUNS_SERVICE_URL = "http://localhost:5000/";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: "new-run-456" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-2",
      orgId: "org-1",
      userId: "user-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/runs/start",
      expect.anything()
    );
  });

  it("throws on non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("boom"),
      })
    );

    await expect(
      createRun({ parentRunId: "caller-run-3", orgId: "org-1", userId: "user-1" })
    ).rejects.toThrow("runs-service error:");
  });

  it("throws if RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;

    await expect(
      createRun({ parentRunId: "caller-run-4", orgId: "org-1", userId: "user-1" })
    ).rejects.toThrow("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
  });

  it("throws if RUNS_SERVICE_API_KEY is not set", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;

    await expect(
      createRun({ parentRunId: "caller-run-5", orgId: "org-1", userId: "user-1" })
    ).rejects.toThrow("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
  });
});
