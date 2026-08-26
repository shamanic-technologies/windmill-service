import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateWorkflow,
  setChatServiceClient,
  GenerationValidationError,
} from "../../src/lib/workflow-generator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
} from "../../src/lib/prompt-templates.js";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";
import type {
  ChatServiceCompleteRequest,
  ChatServiceCompleteResponse,
} from "../../src/lib/chat-service-client.js";
import type { DownstreamHeaders } from "../../src/lib/downstream-headers.js";

// Mock api-registry-client
const mockFetchLlmContext = vi.fn();
const mockFetchSpecsForServices = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchLlmContext: (...args: unknown[]) => mockFetchLlmContext(...args),
  fetchSpecsForServices: (...args: unknown[]) => mockFetchSpecsForServices(...args),
}));

// --- Prompt building tests ---

describe("buildSystemPrompt", () => {
  it("includes DAG format documentation", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("DAG Format");
    expect(prompt).toContain("http.call");
    expect(prompt).toContain("$ref:flow_input");
    expect(prompt).toContain("$ref:node-id.output");
  });

  it("includes all dimension enum values", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"sales"');
    expect(prompt).toContain('"pr"');
    expect(prompt).toContain('"outlets"');
    expect(prompt).toContain('"journalists"');
    expect(prompt).toContain('"email"');
    expect(prompt).toContain('"database"');
    expect(prompt).toContain('"cold-outreach"');
    expect(prompt).toContain('"discovery"');
  });

  it("offers a truthful vocabulary for a paid-reach workflow", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"advertising"');
    expect(prompt).toContain('"ads"');
    expect(prompt).toContain('"audience-targeting"');
    expect(prompt).toContain("Google Ads");
  });

  it("includes service context when provided", () => {
    const prompt = buildSystemPrompt({
      serviceContext: {
        services: [{ name: "lead", description: "Lead management", endpointCount: 3 }],
        specs: { lead: { openapi: "3.0.0" } },
      },
    });
    expect(prompt).toContain("Available Services");
    expect(prompt).toContain("lead");
    expect(prompt).toContain("Lead management");
    expect(prompt).toContain("Service OpenAPI Specs");
  });

  it("includes example DAGs", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Example");
    expect(prompt).toContain("gate-check");
    expect(prompt).toContain("fetch-lead");
  });

  it("includes special config keys documentation", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("stopAfterIf");
    expect(prompt).toContain("skipIf");
    expect(prompt).toContain("validateResponse");
    expect(prompt).toContain("retries");
  });

  it("includes node type registry", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"http.call"');
    expect(prompt).toContain('"condition"');
    expect(prompt).toContain('"wait"');
    expect(prompt).toContain('"for-each"');
  });

  it("includes campaign execution model", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Campaign Execution Model");
    expect(prompt).toContain("budget");
    expect(prompt).toContain("gate-check");
    expect(prompt).toContain("every minute");
  });

  it("includes JSON output format instructions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Output Format");
    expect(prompt).toContain("Return ONLY the JSON object");
  });
});

describe("buildRetryUserMessage", () => {
  it("includes validation errors and original description", () => {
    const msg = buildRetryUserMessage("Send an email to leads", [
      { field: "nodes[bad-ref].inputMapping.data", message: 'References unknown node: "nonexistent"' },
      { field: "edges", message: "Workflow contains a cycle" },
    ]);
    expect(msg).toContain("References unknown node");
    expect(msg).toContain("cycle");
    expect(msg).toContain("Send an email to leads");
  });
});

// --- Generator tests ---

function createMockResponse(dag: unknown, overrides?: Record<string, unknown>): ChatServiceCompleteResponse {
  return {
    content: JSON.stringify({
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Generated workflow description",
      dag,
      ...overrides,
    }),
    json: {
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      description: "Generated workflow description",
      dag,
      ...overrides,
    },
    tokensInput: 100,
    tokensOutput: 200,
    model: "claude-sonnet-4-6",
  };
}

const TEST_IDENTITY: DownstreamHeaders = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

const MOCK_LLM_CONTEXT = {
  _description: "LLM-friendly context",
  _usage: "Use this to discover services",
  services: [
    {
      service: "lead",
      description: "Lead buffer management",
      endpointCount: 2,
    },
    {
      service: "campaign",
      description: "Campaign lifecycle",
      endpointCount: 1,
    },
  ],
};

const MOCK_SPECS_MAP = new Map([
  ["lead", {
    openapi: "3.0.0",
    info: { title: "Lead Service", version: "1.0.0" },
    paths: {
      "/buffer/next": {
        post: {
          summary: "Get next lead",
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { campaignId: { type: "string" } } } } },
          },
        },
      },
    },
  }],
  ["campaign", {
    openapi: "3.0.0",
    info: { title: "Campaign Service", version: "1.0.0" },
    paths: {},
  }],
  ["content-generation", {
    openapi: "3.0.0",
    info: { title: "Content Generation Service", version: "1.0.0" },
    paths: {
      "/generate": {
        post: {
          summary: "Generate content",
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { type: { type: "string" } } } } },
          },
        },
      },
    },
  }],
]);

describe("generateWorkflow", () => {
  let mockComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockComplete = vi.fn();
    setChatServiceClient(mockComplete);
    process.env.API_REGISTRY_SERVICE_URL = "http://fake-registry";
    process.env.API_REGISTRY_SERVICE_API_KEY = "test-key";
    process.env.CHAT_SERVICE_URL = "http://fake-chat";
    process.env.CHAT_SERVICE_API_KEY = "test-chat-key";
    mockFetchLlmContext.mockReset();
    mockFetchSpecsForServices.mockReset();
    mockFetchLlmContext.mockResolvedValue(MOCK_LLM_CONTEXT);
    mockFetchSpecsForServices.mockResolvedValue(MOCK_SPECS_MAP);
  });

  afterEach(() => {
    setChatServiceClient(null);
    delete process.env.API_REGISTRY_SERVICE_URL;
    delete process.env.API_REGISTRY_SERVICE_API_KEY;
    delete process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_API_KEY;
  });

  it("throws if API_REGISTRY env vars are missing", async () => {
    delete process.env.API_REGISTRY_SERVICE_URL;
    delete process.env.API_REGISTRY_SERVICE_API_KEY;

    await expect(
      generateWorkflow({ description: "test" }, TEST_IDENTITY),
    ).rejects.toThrow("API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set");
  });

  it("keeps the paid-reach vocabulary the model returns", async () => {
    mockComplete.mockResolvedValueOnce(
      createMockResponse(VALID_LINEAR_DAG, {
        category: "advertising",
        channel: "ads",
        audienceType: "audience-targeting",
      }),
    );

    const result = await generateWorkflow(
      { description: "Run a Google Ads campaign for the brand" },
      TEST_IDENTITY,
    );

    expect(result.category).toBe("advertising");
    expect(result.channel).toBe("ads");
    expect(result.audienceType).toBe("audience-targeting");
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("retries, then fails loudly, when the model invents a dimension tag", async () => {
    mockComplete.mockResolvedValue(
      createMockResponse(VALID_LINEAR_DAG, { channel: "google-ads" }),
    );

    await expect(
      generateWorkflow({ description: "Run a Google Ads campaign" }, TEST_IDENTITY),
    ).rejects.toMatchObject({
      name: "GenerationValidationError",
      validationErrors: [
        expect.objectContaining({
          field: "channel",
          message: expect.stringContaining('"google-ads"'),
        }),
      ],
    });
  });

  it("returns valid DAG on first attempt", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Search leads and send cold emails" },
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(result.category).toBe("sales");
    expect(result.channel).toBe("email");
    expect(result.audienceType).toBe("cold-outreach");
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("retries with error feedback when DAG is invalid", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockComplete.mockResolvedValueOnce(createMockResponse(invalidDag));
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Search leads and send cold emails" },
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockComplete).toHaveBeenCalledTimes(2);

    // Verify retry message includes error context
    const retryCall = mockComplete.mock.calls[1][0] as ChatServiceCompleteRequest;
    expect(retryCall.message).toContain("invalid");
  });

  it("throws GenerationValidationError after max retries", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockComplete.mockResolvedValue(createMockResponse(invalidDag));

    await expect(
      generateWorkflow({ description: "Bad workflow" }, TEST_IDENTITY),
    ).rejects.toThrow(GenerationValidationError);

    // 1 initial + 2 retries = 3 calls
    expect(mockComplete).toHaveBeenCalledTimes(3);
  });

  it("passes hints to the user message", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow(
      {
        description: "Send email to leads",
        hints: {
          services: ["lead", "email-gateway"],
          expectedInputs: ["campaignId"],
        },
      },
      TEST_IDENTITY,
    );

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.message).toContain("lead, email-gateway");
    expect(call.message).toContain("campaignId");
  });

  it("throws if LLM returns no JSON", async () => {
    mockComplete.mockResolvedValueOnce({
      content: "I cannot generate a workflow",
      tokensInput: 100,
      tokensOutput: 50,
      model: "claude-sonnet-4-6",
    });

    await expect(
      generateWorkflow({ description: "test workflow" }, TEST_IDENTITY),
    ).rejects.toThrow("LLM did not return valid JSON");
  });

  it("includes system prompt with DAG schema and service context", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.systemPrompt).toContain("DAG Format");
    expect(call.systemPrompt).toContain("http.call");
    expect(call.systemPrompt).toContain("Available Services");
    expect(call.systemPrompt).toContain("lead");
  });

  it("uses responseFormat json", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.responseFormat).toBe("json");
  });

  it("uses google pro model", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.provider).toBe("google");
    expect(call.model).toBe("pro");
  });

  it("uses 16384 maxTokens", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.maxTokens).toBe(16384);
  });

  it("pre-fetches all service context before calling LLM", async () => {
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    expect(mockFetchLlmContext).toHaveBeenCalledTimes(1);
    expect(mockFetchSpecsForServices).toHaveBeenCalledWith(
      ["lead", "campaign"],
      TEST_IDENTITY,
    );
    // LLM called only once — no agentic loop
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("filters out the 'api' service from LLM context (services list + specs map)", async () => {
    mockFetchLlmContext.mockResolvedValueOnce({
      _description: "LLM-friendly context",
      _usage: "Use this to discover services",
      services: [
        { service: "lead", description: "Lead service", endpointCount: 2 },
        { service: "api", description: "Proxy", endpointCount: 99 },
        { service: "campaign", description: "Campaign service", endpointCount: 1 },
      ],
    });
    mockFetchSpecsForServices.mockResolvedValueOnce(new Map([
      ["lead", { paths: { "/buffer/next": { post: {} } } }],
      ["campaign", { paths: { "/gate-check": { post: {} } } }],
    ]));
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    // 'api' must NOT be passed to fetchSpecsForServices
    expect(mockFetchSpecsForServices).toHaveBeenCalledWith(
      ["lead", "campaign"],
      TEST_IDENTITY,
    );

    // 'api' must NOT appear in system prompt service list
    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.systemPrompt).not.toContain("- **api**:");
    expect(call.systemPrompt).toContain("- **lead**:");
    expect(call.systemPrompt).toContain("- **campaign**:");
  });

  it("filters 'api' from specs map even if returned by registry", async () => {
    mockFetchLlmContext.mockResolvedValueOnce({
      _description: "LLM-friendly context",
      _usage: "Use this to discover services",
      services: [
        { service: "lead", description: "Lead service", endpointCount: 2 },
        { service: "api", description: "Proxy", endpointCount: 99 },
      ],
    });
    // Registry still returns api spec defensively — generator must drop it
    mockFetchSpecsForServices.mockResolvedValueOnce(new Map([
      ["lead", { paths: { "/buffer/next": { post: {} } } }],
      ["api", { paths: { "/v1/campaigns/pipeline/gate-check": { post: {} } } }],
    ]));
    mockComplete.mockResolvedValueOnce(createMockResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_IDENTITY);

    const call = mockComplete.mock.calls[0][0] as ChatServiceCompleteRequest;
    expect(call.systemPrompt).not.toContain("/v1/campaigns/pipeline/gate-check");
    expect(call.systemPrompt).not.toContain('"api":');
  });

});
