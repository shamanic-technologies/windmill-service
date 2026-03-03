import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("node scripts inject identity headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  const emailEnvs: Record<string, string> = {
    TRANSACTIONAL_EMAIL_SERVICE_URL: "https://email.example.com",
    TRANSACTIONAL_EMAIL_SERVICE_API_KEY: "email-key-123",
  };

  const stripeEnvs: Record<string, string> = {
    STRIPE_SERVICE_URL: "https://stripe.example.com",
    STRIPE_SERVICE_API_KEY: "stripe-key-123",
  };

  const clientEnvs: Record<string, string> = {
    CLIENT_SERVICE_URL: "https://client.example.com",
    CLIENT_SERVICE_API_KEY: "client-key-123",
  };

  describe("transactional-email-send", () => {
    it("sends x-org-id, x-user-id, x-run-id as HTTP headers", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-send.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main(
        "contact_welcome",       // eventType
        "test@example.com",      // recipientEmail
        undefined,               // brandId
        undefined,               // campaignId
        undefined,               // productId
        "user-uuid-1",           // userId
        "org-uuid-1",            // orgId
        undefined,               // metadata
        emailEnvs,               // serviceEnvs
        "run-uuid-1",            // runId
      );

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://email.example.com/send");
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("email-key-123");
    });

    it("omits identity headers when params are undefined", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-send.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await main("contact_welcome", "test@example.com", undefined, undefined, undefined, undefined, undefined, undefined, emailEnvs);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBeUndefined();
      expect(options.headers["x-user-id"]).toBeUndefined();
      expect(options.headers["x-run-id"]).toBeUndefined();
      expect(options.headers["x-api-key"]).toBe("email-key-123");
    });
  });

  describe("transactional-email-get-stats", () => {
    it("sends x-org-id, x-user-id, x-run-id as HTTP headers", async () => {
      const { main } = await import("../../scripts/nodes/transactional-email-get-stats.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ sent: 10 }));

      await main(
        "org-uuid-1",   // orgId
        "user-uuid-1",  // userId
        "welcome",      // eventType
        emailEnvs,      // serviceEnvs
        "run-uuid-1",   // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });
  });

  describe("stripe-create-product", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/stripe-create-product.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ productId: "prod_1" }));

      await main(
        "org-uuid-1",    // orgId
        "Test Product",  // name
        undefined,       // description
        undefined,       // id
        undefined,       // metadata
        stripeEnvs,      // serviceEnvs
        "user-uuid-1",   // userId
        "run-uuid-1",    // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("stripe-key-123");
    });
  });

  describe("client-create-user", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/client-create-user.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "u-1" }));

      await main(
        "org-uuid-1",         // orgId
        "test@example.com",   // email
        undefined,            // firstName
        undefined,            // lastName
        undefined,            // phone
        undefined,            // metadata
        clientEnvs,           // serviceEnvs
        "user-uuid-1",        // userId
        "run-uuid-1",         // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("client-key-123");
    });
  });

  describe("app-resolve-product", () => {
    it("sends identity headers", async () => {
      const { main } = await import("../../scripts/nodes/app-resolve-product.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ productId: "prod_1", name: "Test" }));

      await main(
        "prod_1",        // productId
        stripeEnvs,      // serviceEnvs
        "org-uuid-1",    // orgId
        "user-uuid-1",   // userId
        "run-uuid-1",    // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
      expect(options.headers["x-api-key"]).toBe("stripe-key-123");
    });
  });

  const brandEnvs: Record<string, string> = {
    BRAND_SERVICE_URL: "https://brand.example.com",
    BRAND_SERVICE_API_KEY: "brand-key-123",
  };

  const contentGenEnvs: Record<string, string> = {
    CONTENT_GENERATION_URL: "https://content.example.com",
    CONTENT_GENERATION_API_KEY: "content-key-123",
  };

  const replyQualEnvs: Record<string, string> = {
    REPLY_QUALIFICATION_URL: "https://reply.example.com",
    REPLY_QUALIFICATION_API_KEY: "reply-key-123",
  };

  const leadEnvs: Record<string, string> = {
    LEAD_SERVICE_URL: "https://lead.example.com",
    LEAD_SERVICE_API_KEY: "lead-key-123",
  };

  const outboundEnvs: Record<string, string> = {
    OUTBOUND_SENDING_URL: "https://outbound.example.com",
    OUTBOUND_SENDING_API_KEY: "outbound-key-123",
  };

  describe("brand-intel", () => {
    it("sends identity headers via top-level params", async () => {
      const { main } = await import("../../scripts/nodes/brand-intel.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "Acme" }));

      await main(
        "get",                                    // action
        { orgId: "ctx-org", brandId: "brand-1" }, // context
        brandEnvs,                                // serviceEnvs
        "org-uuid-1",                             // orgId (top-level)
        "user-uuid-1",                            // userId
        "run-uuid-1",                             // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });

    it("falls back to context.orgId when top-level orgId is undefined", async () => {
      const { main } = await import("../../scripts/nodes/brand-intel.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "Acme" }));

      await main(
        "get",
        { orgId: "ctx-org", brandId: "brand-1" },
        brandEnvs,
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("ctx-org");
      expect(options.headers["x-user-id"]).toBeUndefined();
      expect(options.headers["x-run-id"]).toBeUndefined();
    });
  });

  describe("content-generation", () => {
    it("sends identity headers via top-level params", async () => {
      const { main } = await import("../../scripts/nodes/content-generation.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "c1", subject: "Hi", bodyHtml: "<p>hi</p>" }));

      await main(
        "email",                                                       // contentType
        { email: "lead@test.com" },                                    // leadData
        {},                                                            // clientData
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" }, // context
        contentGenEnvs,                                                // serviceEnvs
        "org-uuid-1",                                                  // orgId
        "user-uuid-1",                                                 // userId
        "run-uuid-1",                                                  // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });

    it("falls back to context.orgId and context.runId", async () => {
      const { main } = await import("../../scripts/nodes/content-generation.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: "c1", subject: "Hi", bodyHtml: "<p>hi</p>" }));

      await main(
        "email",
        { email: "lead@test.com" },
        {},
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" },
        contentGenEnvs,
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("ctx-org");
      expect(options.headers["x-run-id"]).toBe("ctx-run");
      expect(options.headers["x-user-id"]).toBeUndefined();
    });
  });

  describe("content-sentiment", () => {
    it("sends identity headers via top-level params", async () => {
      const { main } = await import("../../scripts/nodes/content-sentiment.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ sentiment: "positive", category: "interested" }));

      await main(
        "Thanks for reaching out!",    // emailContent
        { orgId: "ctx-org" },          // context
        replyQualEnvs,                 // serviceEnvs
        "org-uuid-1",                  // orgId
        "user-uuid-1",                 // userId
        "run-uuid-1",                  // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });
  });

  describe("lead-service", () => {
    it("sends identity headers via top-level params", async () => {
      const { main } = await import("../../scripts/nodes/lead-service.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: true, lead: { email: "a@b.com" } }));

      await main(
        "apollo",                                                               // source
        undefined,                                                              // searchParams
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" }, // context
        leadEnvs,                                                               // serviceEnvs
        "org-uuid-1",                                                           // orgId
        "user-uuid-1",                                                          // userId
        "run-uuid-1",                                                           // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });

    it("falls back to context.orgId and context.runId", async () => {
      const { main } = await import("../../scripts/nodes/lead-service.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ found: true, lead: { email: "a@b.com" } }));

      await main(
        "apollo",
        undefined,
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" },
        leadEnvs,
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("ctx-org");
      expect(options.headers["x-run-id"]).toBe("ctx-run");
      expect(options.headers["x-user-id"]).toBeUndefined();
    });
  });

  describe("outbound-sending", () => {
    it("sends identity headers via top-level params", async () => {
      const { main } = await import("../../scripts/nodes/outbound-sending.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, messageId: "msg-1" }));

      await main(
        "email",                                                                 // channel
        "cold",                                                                  // sendType
        "lead@test.com",                                                         // toEmail
        "Hello",                                                                 // subject
        "<p>Hi</p>",                                                             // bodyHtml
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" }, // context
        outboundEnvs,                                                            // serviceEnvs
        "org-uuid-1",                                                            // orgId
        "user-uuid-1",                                                           // userId
        "run-uuid-1",                                                            // runId
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("org-uuid-1");
      expect(options.headers["x-user-id"]).toBe("user-uuid-1");
      expect(options.headers["x-run-id"]).toBe("run-uuid-1");
    });

    it("falls back to context.orgId and context.runId", async () => {
      const { main } = await import("../../scripts/nodes/outbound-sending.js");
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, messageId: "msg-1" }));

      await main(
        "email",
        "cold",
        "lead@test.com",
        "Hello",
        "<p>Hi</p>",
        { orgId: "ctx-org", brandId: "b1", campaignId: "c1", runId: "ctx-run" },
        outboundEnvs,
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["x-org-id"]).toBe("ctx-org");
      expect(options.headers["x-run-id"]).toBe("ctx-run");
      expect(options.headers["x-user-id"]).toBeUndefined();
    });
  });
});
