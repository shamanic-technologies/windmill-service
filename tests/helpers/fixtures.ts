import type { DAG } from "../../src/lib/dag-validator.js";

export const VALID_LINEAR_DAG: DAG = {
  nodes: [
    {
      id: "lead-search",
      type: "lead-service",
      config: { source: "apollo" },
    },
    {
      id: "email-gen",
      type: "content-generation",
      config: { contentType: "cold-email" },
      inputMapping: {
        leadData: "$ref:lead-search.output.lead",
        clientData: "$ref:flow_input.brandIntel",
      },
    },
    {
      id: "email-send",
      type: "outbound-sending",
      config: { channel: "email", sendType: "broadcast" },
      inputMapping: {
        toEmail: "$ref:email-gen.output.email",
        subject: "$ref:email-gen.output.subject",
        bodyHtml: "$ref:email-gen.output.bodyHtml",
      },
    },
  ],
  edges: [
    { from: "lead-search", to: "email-gen" },
    { from: "email-gen", to: "email-send" },
  ],
};

export const DAG_WITH_CYCLE: DAG = {
  nodes: [
    { id: "a", type: "lead-service" },
    { id: "b", type: "content-generation" },
    { id: "c", type: "outbound-sending" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ],
};

export const DAG_WITH_UNKNOWN_TYPE: DAG = {
  nodes: [{ id: "x", type: "unknown-service" }],
  edges: [],
};

export const DAG_WITH_BAD_EDGE: DAG = {
  nodes: [{ id: "a", type: "lead-service" }],
  edges: [{ from: "a", to: "nonexistent" }],
};

export const DAG_WITH_BAD_REF: DAG = {
  nodes: [
    { id: "a", type: "lead-service" },
    {
      id: "b",
      type: "content-generation",
      inputMapping: { data: "$ref:nonexistent.output.field" },
    },
  ],
  edges: [{ from: "a", to: "b" }],
};

export const DAG_WITH_DUPLICATE_IDS: DAG = {
  nodes: [
    { id: "a", type: "lead-service" },
    { id: "a", type: "content-generation" },
  ],
  edges: [],
};

export const DAG_NO_ENTRY_NODE: DAG = {
  nodes: [
    { id: "a", type: "lead-service" },
    { id: "b", type: "content-generation" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ],
};

export const DAG_WITH_WAIT: DAG = {
  nodes: [
    { id: "step1", type: "lead-service" },
    { id: "pause", type: "wait", config: { seconds: 30 } },
    { id: "step2", type: "outbound-sending" },
  ],
  edges: [
    { from: "step1", to: "pause" },
    { from: "pause", to: "step2" },
  ],
};

export const DAG_WITH_CONDITION: DAG = {
  nodes: [
    { id: "check", type: "condition" },
    { id: "branch-a", type: "transactional-email.send" },
    { id: "branch-b", type: "outbound-sending" },
  ],
  edges: [
    { from: "check", to: "branch-a", condition: "results.check.score > 50" },
    { from: "check", to: "branch-b", condition: "results.check.score <= 50" },
  ],
};

export const DAG_WITH_FOREACH: DAG = {
  nodes: [
    {
      id: "loop",
      type: "for-each",
      config: { iterator: "flow_input.contacts", parallel: false },
    },
    { id: "send", type: "transactional-email.send" },
  ],
  edges: [{ from: "loop", to: "send" }],
};

export const DAG_WITH_STRIPE_NODES: DAG = {
  nodes: [
    {
      id: "create-product",
      type: "stripe.createProduct",
      config: { name: "Test Product" },
    },
    {
      id: "create-price",
      type: "stripe.createPrice",
      config: { unitAmountInCents: 1999 },
      inputMapping: {
        productId: "$ref:create-product.output.productId",
      },
    },
    {
      id: "create-checkout",
      type: "stripe.createCheckout",
      config: { successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" },
      inputMapping: {
        priceId: "$ref:create-price.output.priceId",
      },
    },
  ],
  edges: [
    { from: "create-product", to: "create-price" },
    { from: "create-price", to: "create-checkout" },
  ],
};

export const DAG_WITH_CLIENT_NODES: DAG = {
  nodes: [
    {
      id: "create-user",
      type: "client.createUser",
      config: { appId: "test-app", email: "test@example.com" },
    },
    {
      id: "list-users",
      type: "client.getUsers",
      config: { appId: "test-app" },
    },
    {
      id: "update-user",
      type: "client.updateUser",
      config: { firstName: "Updated" },
      inputMapping: {
        userId: "$ref:create-user.output.user.id",
      },
    },
  ],
  edges: [
    { from: "create-user", to: "list-users" },
    { from: "list-users", to: "update-user" },
  ],
};

export const DAG_WITH_TRANSACTIONAL_EMAIL_SEND: DAG = {
  nodes: [
    {
      id: "send-email",
      type: "transactional-email.send",
      config: { appId: "test-app", eventType: "welcome" },
    },
  ],
  edges: [],
};

export const DAG_WITH_MIXED_DOT_NOTATION: DAG = {
  nodes: [
    {
      id: "create-user",
      type: "client.createUser",
      config: { appId: "test-app", email: "user@example.com" },
    },
    {
      id: "send-welcome",
      type: "transactional-email.send",
      config: { appId: "test-app", eventType: "welcome" },
      inputMapping: {
        recipientEmail: "$ref:create-user.output.user.email",
      },
    },
    {
      id: "resolve-product",
      type: "app.resolveProduct",
      config: { productKey: "welcome-offer" },
    },
  ],
  edges: [
    { from: "create-user", to: "send-welcome" },
    { from: "create-user", to: "resolve-product" },
  ],
};

export const DAG_WITH_HTTP_CALL: DAG = {
  nodes: [
    {
      id: "get-product",
      type: "http.call",
      config: { service: "stripe", method: "GET", path: "/products/prod_123" },
    },
  ],
  edges: [],
};

export const DAG_WITH_HTTP_CALL_CHAIN: DAG = {
  nodes: [
    {
      id: "create-user",
      type: "http.call",
      config: { service: "client", method: "POST", path: "/users" },
      inputMapping: {
        body: "$ref:flow_input.userData",
      },
    },
    {
      id: "send-welcome",
      type: "http.call",
      config: {
        service: "transactional-email",
        method: "POST",
        path: "/send",
      },
      inputMapping: {
        body: "$ref:create-user.output",
      },
    },
  ],
  edges: [{ from: "create-user", to: "send-welcome" }],
};

export const DAG_WITH_RETRIES_ZERO: DAG = {
  nodes: [
    {
      id: "send-email",
      type: "transactional-email.send",
      config: { appId: "test-app", eventType: "welcome" },
      retries: 0,
    },
  ],
  edges: [],
};

export const DAG_WITH_CUSTOM_RETRIES: DAG = {
  nodes: [
    {
      id: "search",
      type: "lead-service",
      config: { source: "apollo" },
      retries: 5,
    },
    {
      id: "send-email",
      type: "transactional-email.send",
      config: { eventType: "outreach" },
      inputMapping: { recipientEmail: "$ref:search.output.email" },
      retries: 0,
    },
  ],
  edges: [{ from: "search", to: "send-email" }],
};

export const DAG_WITH_ON_ERROR: DAG = {
  nodes: [
    {
      id: "start-run",
      type: "http.call",
      config: { service: "runs", method: "POST", path: "/runs/start" },
    },
    {
      id: "do-work",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/buffer/next" },
      retries: 0,
      inputMapping: {
        runId: "$ref:start-run.output.runId",
      },
    },
    {
      id: "end-run",
      type: "http.call",
      config: { service: "runs", method: "POST", path: "/runs/end" },
      inputMapping: {
        runId: "$ref:start-run.output.runId",
        success: "$ref:flow_input.success",
      },
    },
  ],
  edges: [
    { from: "start-run", to: "do-work" },
    { from: "do-work", to: "end-run" },
  ],
  onError: "end-run",
};

export const DAG_WITH_BAD_ON_ERROR: DAG = {
  nodes: [{ id: "a", type: "lead-service" }],
  edges: [],
  onError: "nonexistent-handler",
};

export const DAG_WITH_FLOW_INPUT_REFS: DAG = {
  nodes: [
    {
      id: "start-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/internal/start-run" },
      inputMapping: {
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      },
      retries: 0,
    },
  ],
  edges: [],
};

export const DAG_WITH_CONFIG_RETRIES: DAG = {
  nodes: [
    {
      id: "start-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/internal/start-run", retries: 0 },
      inputMapping: {
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      },
    },
  ],
  edges: [],
};

export const DAG_WITH_DOT_NOTATION_AND_STATIC_BASE: DAG = {
  nodes: [
    {
      id: "email-send",
      type: "http.call",
      config: {
        service: "email-gateway",
        method: "POST",
        path: "/send",
        retries: 0,
        body: { tag: "cold-email", type: "broadcast", metadata: { source: "campaign-service" } },
      },
      inputMapping: {
        "body.to": "$ref:start-run.output.lead.data.email",
        "body.appId": "$ref:start-run.output.appId",
        "body.subject": "$ref:email-generate.output.subject",
        "body.metadata.emailGenerationId": "$ref:email-generate.output.id",
      },
    },
  ],
  edges: [],
};

export const DAG_WITH_STOP_AFTER_IF: DAG = {
  nodes: [
    {
      id: "fetch-lead",
      type: "http.call",
      config: {
        service: "lead",
        method: "POST",
        path: "/buffer/next",
        stopAfterIf: "result.found == false",
      },
      retries: 0,
    },
    {
      id: "email-gen",
      type: "content-generation",
      config: { contentType: "cold-email" },
      inputMapping: {
        leadData: "$ref:fetch-lead.output.lead",
      },
    },
  ],
  edges: [{ from: "fetch-lead", to: "email-gen" }],
};

export const DAG_WITH_SKIP_IF: DAG = {
  nodes: [
    {
      id: "fetch-lead",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/buffer/next" },
      retries: 0,
    },
    {
      id: "email-gen",
      type: "http.call",
      config: {
        service: "ai",
        method: "POST",
        path: "/generate",
        skipIf: "results.fetch_lead.found == false",
      },
    },
    {
      id: "end-run",
      type: "http.call",
      config: { service: "campaign", method: "POST", path: "/end-run" },
    },
  ],
  edges: [
    { from: "fetch-lead", to: "email-gen" },
    { from: "email-gen", to: "end-run" },
  ],
};

export const DAG_WITH_CONDITION_CHAIN: DAG = {
  nodes: [
    {
      id: "fetch-lead",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/buffer/next" },
      retries: 0,
    },
    { id: "check-lead", type: "condition" },
    {
      id: "email-gen",
      type: "http.call",
      config: { service: "ai", method: "POST", path: "/generate" },
    },
    {
      id: "email-send",
      type: "http.call",
      config: { service: "email", method: "POST", path: "/send" },
    },
    {
      id: "end-run",
      type: "http.call",
      config: { service: "runs", method: "POST", path: "/runs/end" },
    },
  ],
  edges: [
    { from: "fetch-lead", to: "check-lead" },
    { from: "check-lead", to: "email-gen", condition: "results.fetch_lead.found == true" },
    { from: "email-gen", to: "email-send" },
    { from: "check-lead", to: "end-run" },
  ],
};

export const DAG_WITH_TWO_BRANCHES: DAG = {
  nodes: [
    { id: "check-score", type: "condition" },
    {
      id: "send-email",
      type: "http.call",
      config: { service: "email", method: "POST", path: "/send" },
    },
    {
      id: "send-sms",
      type: "http.call",
      config: { service: "sms", method: "POST", path: "/send" },
    },
    {
      id: "log-result",
      type: "http.call",
      config: { service: "log", method: "POST", path: "/log" },
    },
  ],
  edges: [
    { from: "check-score", to: "send-email", condition: "results.check_score.score > 50" },
    { from: "check-score", to: "send-sms", condition: "results.check_score.score <= 50" },
    { from: "check-score", to: "log-result" },
  ],
};

export const POLARITY_WELCOME_DAG: DAG = {
  nodes: [
    {
      id: "send-welcome",
      type: "transactional-email.send",
      config: {
        appId: "polaritycourse",
        eventType: "webinar-registration-welcome",
      },
      inputMapping: {
        recipientEmail: "$ref:flow_input.email",
        metadata: "$ref:flow_input.contactData",
      },
    },
  ],
  edges: [],
};
