import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRun, createPlatformRun, closePlatformRun } from "../../src/lib/runs-client.js";

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

  it("calls POST /v1/runs with serviceName + taskName in body and identity in headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-123" }),
      })
    );

    const result = await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
    });

    expect(result).toEqual({ runId: "new-run-123" });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs",
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
          serviceName: "workflow",
          taskName: "execute-workflow",
        }),
      })
    );
  });

  it("includes workflowName in body when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-789" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowName: "sales-email-cold-outreach",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs",
      expect.objectContaining({
        body: JSON.stringify({
          serviceName: "workflow",
          taskName: "execute-workflow",
          workflowName: "sales-email-cold-outreach",
        }),
      })
    );
  });

  it("includes campaignId and brandId in body and forwards tracking headers when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-tracking" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
      workflowName: "sales-email-cold-outreach",
      campaignId: "camp-123",
      brandId: "brand-456",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-123",
          "x-brand-id": "brand-456",
          "x-workflow-name": "sales-email-cold-outreach",
        }),
        body: JSON.stringify({
          serviceName: "workflow",
          taskName: "execute-workflow",
          workflowName: "sales-email-cold-outreach",
          campaignId: "camp-123",
          brandId: "brand-456",
        }),
      })
    );
  });

  it("does not send tracking headers when campaignId/brandId are not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-no-tracking" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
    });

    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty("x-campaign-id");
    expect(calledHeaders).not.toHaveProperty("x-brand-id");
    expect(calledHeaders).not.toHaveProperty("x-workflow-name");
  });

  it("does not send orgId, userId, or parentRunId in request body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-456" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-1",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
    });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(callArgs[1].body);
    expect(sentBody).not.toHaveProperty("orgId");
    expect(sentBody).not.toHaveProperty("userId");
    expect(sentBody).not.toHaveProperty("parentRunId");
  });

  it("strips trailing slash from RUNS_SERVICE_URL", async () => {
    process.env.RUNS_SERVICE_URL = "http://localhost:5000/";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-run-456" }),
      })
    );

    await createRun({
      parentRunId: "caller-run-2",
      orgId: "org-1",
      userId: "user-1",
      taskName: "execute-workflow",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/runs",
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
      createRun({ parentRunId: "caller-run-3", orgId: "org-1", userId: "user-1", taskName: "execute-workflow" })
    ).rejects.toThrow("runs-service error:");
  });

  it("throws if RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;

    await expect(
      createRun({ parentRunId: "caller-run-4", orgId: "org-1", userId: "user-1", taskName: "execute-workflow" })
    ).rejects.toThrow("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
  });

  it("throws if RUNS_SERVICE_API_KEY is not set", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;

    await expect(
      createRun({ parentRunId: "caller-run-5", orgId: "org-1", userId: "user-1", taskName: "execute-workflow" })
    ).rejects.toThrow("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set");
  });
});

describe("createPlatformRun", () => {
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

  it("calls POST /v1/platform-runs with x-service-name and no identity headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "platform-run-1" }),
      })
    );

    const result = await createPlatformRun({
      serviceName: "workflow",
      taskName: "startup-upgrade",
    });

    expect(result).toEqual({ runId: "platform-run-1" });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/platform-runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-runs-key",
          "x-service-name": "workflow-service",
        },
        body: JSON.stringify({
          serviceName: "workflow",
          taskName: "startup-upgrade",
        }),
      })
    );

    // Should NOT include identity headers
    const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty("x-org-id");
    expect(calledHeaders).not.toHaveProperty("x-user-id");
    expect(calledHeaders).not.toHaveProperty("x-run-id");
  });

  it("includes workflowName when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "platform-run-2" }),
      })
    );

    await createPlatformRun({
      serviceName: "workflow",
      taskName: "startup-upgrade",
      workflowName: "sales-email-cold-outreach",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/platform-runs",
      expect.objectContaining({
        body: JSON.stringify({
          serviceName: "workflow",
          taskName: "startup-upgrade",
          workflowName: "sales-email-cold-outreach",
        }),
      })
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
      createPlatformRun({ serviceName: "workflow", taskName: "startup-upgrade" })
    ).rejects.toThrow("runs-service error: POST /v1/platform-runs");
  });
});

describe("closePlatformRun", () => {
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

  it("calls PATCH /v1/platform-runs/:id with status body and x-service-name header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await closePlatformRun("run-abc", "completed");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/platform-runs/run-abc",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-runs-key",
          "x-service-name": "workflow-service",
        },
        body: JSON.stringify({ status: "completed" }),
      })
    );
  });

  it("sends 'failed' status when run fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );

    await closePlatformRun("run-def", "failed");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:5000/v1/platform-runs/run-def",
      expect.objectContaining({
        body: JSON.stringify({ status: "failed" }),
      })
    );
  });

  it("throws on non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("run not found"),
      })
    );

    await expect(
      closePlatformRun("run-missing", "completed")
    ).rejects.toThrow("runs-service error: PATCH /v1/platform-runs/run-missing");
  });
});
