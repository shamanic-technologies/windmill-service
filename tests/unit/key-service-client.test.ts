import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchProviderRequirements, fetchAnthropicKey } from "../../src/lib/key-service-client.js";

describe("fetchProviderRequirements", () => {
  const originalUrl = process.env.KEY_SERVICE_URL;
  const originalKey = process.env.KEY_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://localhost:4000";
    process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
  });

  afterEach(() => {
    process.env.KEY_SERVICE_URL = originalUrl;
    process.env.KEY_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("throws if KEY_SERVICE_URL is not set", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(fetchProviderRequirements([])).rejects.toThrow(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set"
    );
  });

  it("throws if KEY_SERVICE_API_KEY is not set", async () => {
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(fetchProviderRequirements([])).rejects.toThrow(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set"
    );
  });

  it("calls key-service and returns the response", async () => {
    const mockResponse = {
      requirements: [{ provider: "apollo", fields: ["apiKey"] }],
      providers: ["apollo"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const result = await fetchProviderRequirements([
      { service: "apollo", method: "POST", path: "/search" },
    ]);

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/internal/provider-requirements",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-key-svc-key",
        }),
      })
    );
  });

  it("strips trailing slash from KEY_SERVICE_URL", async () => {
    process.env.KEY_SERVICE_URL = "http://localhost:4000/";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requirements: [], providers: [] }),
      })
    );

    await fetchProviderRequirements([]);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/internal/provider-requirements",
      expect.anything()
    );
  });

  it("throws on non-2xx response from key-service", async () => {
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
      fetchProviderRequirements([
        { service: "apollo", method: "POST", path: "/search" },
      ])
    ).rejects.toThrow("key-service error:");
  });
});

describe("fetchAnthropicKey", () => {
  const originalUrl = process.env.KEY_SERVICE_URL;
  const originalKey = process.env.KEY_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://localhost:4000";
    process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
  });

  afterEach(() => {
    process.env.KEY_SERVICE_URL = originalUrl;
    process.env.KEY_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("calls GET /keys/anthropic/decrypt with orgId and userId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: "sk-ant-key", keySource: "platform" }),
      })
    );

    const result = await fetchAnthropicKey({ orgId: "org-1", userId: "user-1" });

    expect(result).toEqual({ key: "sk-ant-key", keySource: "platform" });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/keys/anthropic/decrypt?orgId=org-1&userId=user-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-key-svc-key",
          "x-caller-service": "workflow",
          "x-caller-method": "POST",
          "x-caller-path": "/workflows/generate",
        }),
      })
    );
  });

  it("returns keySource 'org' when user has own key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: "sk-ant-org-key", keySource: "org" }),
      })
    );

    const result = await fetchAnthropicKey({ orgId: "org-1", userId: "user-1" });

    expect(result.key).toBe("sk-ant-org-key");
    expect(result.keySource).toBe("org");
  });

  it("throws on non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("key not configured"),
      })
    );

    await expect(
      fetchAnthropicKey({ orgId: "org-1", userId: "user-1" })
    ).rejects.toThrow("key-service error:");
  });

  it("throws if KEY_SERVICE_URL is not set", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(
      fetchAnthropicKey({ orgId: "org-1", userId: "user-1" })
    ).rejects.toThrow("KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set");
  });

  it("encodes orgId and userId in query params", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: "sk-key", keySource: "platform" }),
      })
    );

    await fetchAnthropicKey({ orgId: "org with spaces", userId: "user-1" });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/keys/anthropic/decrypt?orgId=org+with+spaces&userId=user-1",
      expect.anything()
    );
  });
});
