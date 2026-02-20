import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { collectServiceEnvs } from "../../src/lib/service-envs.js";

describe("collectServiceEnvs", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all test-relevant env vars
    for (const key of Object.keys(process.env)) {
      if (
        key.endsWith("_SERVICE_URL") ||
        key.endsWith("_SERVICE_API_KEY") ||
        key.endsWith("_URL") ||
        key.endsWith("_API_KEY")
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("collects *_SERVICE_URL and *_SERVICE_API_KEY vars", () => {
    process.env.STRIPE_SERVICE_URL = "https://stripe.example.com";
    process.env.STRIPE_SERVICE_API_KEY = "sk_test_123";
    process.env.CAMPAIGN_SERVICE_URL = "https://campaign.example.com";

    const result = collectServiceEnvs();

    expect(result.STRIPE_SERVICE_URL).toBe("https://stripe.example.com");
    expect(result.STRIPE_SERVICE_API_KEY).toBe("sk_test_123");
    expect(result.CAMPAIGN_SERVICE_URL).toBe("https://campaign.example.com");
  });

  it("collects non-standard legacy env vars ending in _URL or _API_KEY", () => {
    process.env.CONTENT_GENERATION_URL = "https://content.example.com";
    process.env.CONTENT_GENERATION_API_KEY = "cg_key";
    process.env.OUTBOUND_SENDING_URL = "https://outbound.example.com";
    process.env.REPLY_QUALIFICATION_URL = "https://rq.example.com";

    const result = collectServiceEnvs();

    expect(result.CONTENT_GENERATION_URL).toBe("https://content.example.com");
    expect(result.CONTENT_GENERATION_API_KEY).toBe("cg_key");
    expect(result.OUTBOUND_SENDING_URL).toBe("https://outbound.example.com");
    expect(result.REPLY_QUALIFICATION_URL).toBe("https://rq.example.com");
  });

  it("excludes internal Windmill vars", () => {
    process.env.WINDMILL_SERVER_URL = "https://windmill.internal";
    process.env.WINDMILL_SERVER_API_KEY = "wm_key";
    process.env.WORKFLOW_SERVICE_DATABASE_URL = "postgresql://localhost/db";
    process.env.STRIPE_SERVICE_URL = "https://stripe.example.com";

    const result = collectServiceEnvs();

    expect(result.WINDMILL_SERVER_URL).toBeUndefined();
    expect(result.WINDMILL_SERVER_API_KEY).toBeUndefined();
    expect(result.WORKFLOW_SERVICE_DATABASE_URL).toBeUndefined();
    expect(result.STRIPE_SERVICE_URL).toBe("https://stripe.example.com");
  });

  it("excludes RAILWAY_ prefixed vars", () => {
    process.env.RAILWAY_SERVICE_STRIPE_SERVICE_URL = "stripe.example.com";
    process.env.STRIPE_SERVICE_URL = "https://stripe.example.com";

    const result = collectServiceEnvs();

    expect(result.RAILWAY_SERVICE_STRIPE_SERVICE_URL).toBeUndefined();
    expect(result.STRIPE_SERVICE_URL).toBe("https://stripe.example.com");
  });

  it("skips empty values", () => {
    process.env.STRIPE_SERVICE_URL = "";
    process.env.LEAD_SERVICE_URL = "https://lead.example.com";

    const result = collectServiceEnvs();

    expect(result.STRIPE_SERVICE_URL).toBeUndefined();
    expect(result.LEAD_SERVICE_URL).toBe("https://lead.example.com");
  });

  it("excludes DATABASE_URL patterns", () => {
    process.env.SOME_DATABASE_URL = "postgresql://localhost/db";
    process.env.STRIPE_SERVICE_URL = "https://stripe.example.com";

    const result = collectServiceEnvs();

    expect(result.SOME_DATABASE_URL).toBeUndefined();
    expect(result.STRIPE_SERVICE_URL).toBe("https://stripe.example.com");
  });
});
