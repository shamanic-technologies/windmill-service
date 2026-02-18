import { describe, it, expect, vi, beforeEach } from "vitest";
import { main } from "../../scripts/nodes/http-call.js";

// Mock Bun.env globally (script runs in Bun but we test in Node)
const mockEnv: Record<string, string> = {};
vi.stubGlobal("Bun", { env: mockEnv });

// Capture fetch calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("http-call script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  const serviceEnvs: Record<string, string> = {
    LEAD_SERVICE_URL: "https://lead.example.com",
    LEAD_SERVICE_API_KEY: "lead-key-123",
    CAMPAIGN_SERVICE_URL: "https://campaign.example.com",
    CAMPAIGN_SERVICE_API_KEY: "campaign-key-456",
  };

  it("sends default headers (Content-Type + x-api-key)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main("lead", "POST", "/buffer/next", { foo: "bar" }, undefined, serviceEnvs);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
  });

  it("merges custom headers with defaults", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ found: true }));

    await main(
      "lead", "POST", "/buffer/next",
      { campaignId: "c1" },
      undefined,
      serviceEnvs,
      { "x-app-id": "app-1", "x-org-id": "org-1" },
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
    expect(options.headers["x-app-id"]).toBe("app-1");
    expect(options.headers["x-org-id"]).toBe("org-1");
  });

  it("x-api-key takes precedence over custom headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main(
      "lead", "POST", "/test",
      undefined,
      undefined,
      serviceEnvs,
      { "x-api-key": "should-be-overridden" },
    );

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["x-api-key"]).toBe("lead-key-123");
  });

  it("works without custom headers (backward compat)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await main("campaign", "GET", "/status", undefined, undefined, serviceEnvs);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://campaign.example.com/status");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["x-api-key"]).toBe("campaign-key-456");
  });

  it("throws when service URL is missing", async () => {
    await expect(
      main("unknown", "GET", "/test", undefined, undefined, serviceEnvs),
    ).rejects.toThrow("Missing: UNKNOWN_SERVICE_URL");
  });

  describe("validateResponse", () => {
    it("passes when response field matches expected value", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ allowed: true, reason: "ok" }));

      const result = await main(
        "campaign", "POST", "/gate-check",
        { campaignId: "c1" },
        undefined,
        serviceEnvs,
        undefined,
        { field: "allowed", equals: true },
      );

      expect(result).toEqual({ allowed: true, reason: "ok" });
    });

    it("throws when response field does not match (gate-check blocked)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ allowed: false, reason: "3 consecutive failures" }));

      await expect(
        main(
          "campaign", "POST", "/gate-check",
          { campaignId: "c1" },
          undefined,
          serviceEnvs,
          undefined,
          { field: "allowed", equals: true },
        ),
      ).rejects.toThrow("validation failed: expected allowed=true, got false");
    });

    it("throws when response field does not match (fetch-lead empty buffer)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: false }));

      await expect(
        main(
          "lead", "POST", "/buffer/next",
          { campaignId: "c1" },
          undefined,
          serviceEnvs,
          { "x-app-id": "app-1", "x-org-id": "org-1" },
          { field: "found", equals: true },
        ),
      ).rejects.toThrow("validation failed: expected found=true, got false");
    });

    it("does not validate when validateResponse is omitted", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: false }));

      const result = await main(
        "lead", "POST", "/buffer/next",
        undefined,
        undefined,
        serviceEnvs,
      );

      expect(result).toEqual({ found: false });
    });
  });
});
