import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFeatureOutputs, fetchStatsRegistry } from "../../src/lib/features-client.js";
import { extractDownstreamHeaders } from "../../src/lib/downstream-headers.js";

describe("extractDownstreamHeaders", () => {
  it("extracts all known contextual headers from request", () => {
    const req = {
      headers: {
        "x-org-id": "org-abc",
        "x-user-id": "user-def",
        "x-run-id": "run-ghi",
        "x-brand-id": "brand-jkl",
        "x-campaign-id": "camp-mno",
        "x-workflow-slug": "my-workflow",
        "x-feature-slug": "my-feature",
        "x-profile-id": "profile-pqr",
        "x-persona-id": "persona-stu",
        "x-goal-id": "goal-vwx",
        "x-goal-slug": "signups",
        "x-optimization-goal": "signups",
        "x-api-key": "should-not-appear",
      },
    };

    const result = extractDownstreamHeaders(req);

    expect(result).toEqual({
      "x-org-id": "org-abc",
      "x-user-id": "user-def",
      "x-run-id": "run-ghi",
      "x-brand-id": "brand-jkl",
      "x-campaign-id": "camp-mno",
      "x-workflow-slug": "my-workflow",
      "x-feature-slug": "my-feature",
      "x-profile-id": "profile-pqr",
      "x-persona-id": "persona-stu",
      "x-goal-id": "goal-vwx",
      "x-goal-slug": "signups",
      "x-optimization-goal": "signups",
    });
    expect(result).not.toHaveProperty("x-api-key");
  });

  it("omits optional headers that are not present", () => {
    const req = {
      headers: {
        "x-org-id": "org-abc",
        "x-user-id": "user-def",
        "x-run-id": "run-ghi",
      },
    };

    const result = extractDownstreamHeaders(req);

    expect(result).toEqual({
      "x-org-id": "org-abc",
      "x-user-id": "user-def",
      "x-run-id": "run-ghi",
    });
  });
});

describe("fetchFeatureOutputs forwards headers", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("forwards identity headers to features-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ feature: { outputs: [{ key: "emails_sent", displayOrder: 1 }] } }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await fetchFeatureOutputs("sales-cold-email", fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});

describe("fetchStatsRegistry forwards headers", () => {
  const originalUrl = process.env.FEATURES_SERVICE_URL;
  const originalKey = process.env.FEATURES_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://localhost:4000";
    process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  });

  afterEach(() => {
    process.env.FEATURES_SERVICE_URL = originalUrl;
    process.env.FEATURES_SERVICE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("forwards identity headers to features-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ registry: { emails_sent: { type: "count", label: "Emails Sent" } } }),
      }),
    );

    const fwdHeaders = {
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    };

    await fetchStatsRegistry(fwdHeaders);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "x-api-key": "test-features-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        },
      }),
    );
  });
});
