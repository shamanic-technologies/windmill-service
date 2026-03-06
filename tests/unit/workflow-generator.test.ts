import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  generateWorkflow,
  setAnthropicClient,
  GenerationValidationError,
} from "../../src/lib/workflow-generator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
} from "../../src/lib/prompt-templates.js";
import { VALID_LINEAR_DAG } from "../helpers/fixtures.js";

// Mock api-registry-client
const mockFetchLlmContext = vi.fn();
const mockFetchServiceSpec = vi.fn();

vi.mock("../../src/lib/api-registry-client.js", () => ({
  fetchLlmContext: (...args: unknown[]) => mockFetchLlmContext(...args),
  fetchServiceSpec: (...args: unknown[]) => mockFetchServiceSpec(...args),
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
    expect(prompt).toContain('"email"');
    expect(prompt).toContain('"cold-outreach"');
  });

  it("includes service discovery instructions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Service Discovery (MANDATORY)");
    expect(prompt).toContain("list_services");
    expect(prompt).toContain("get_service_endpoints");
    expect(prompt).not.toContain("Available Services");
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

  it("includes style directive when provided", () => {
    const prompt = buildSystemPrompt({
      styleDirective: "This workflow MUST be created in the style of Hormozi. Adopt their methodology, tone, and strategic patterns.",
    });
    expect(prompt).toContain("Style Directive");
    expect(prompt).toContain("Hormozi");
    expect(prompt).toContain("methodology, tone, and strategic patterns");
  });

  it("does not include style directive when not provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Style Directive");
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

function createMockToolResponse(dag: unknown, overrides?: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-opus-4-6",
    stop_reason: "tool_use" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "tool_test_" + Math.random().toString(36).slice(2, 6),
        name: "create_workflow",
        input: {
          category: "sales",
          channel: "email",
          audienceType: "cold-outreach",
          description: "Generated workflow description",
          dag,
          ...overrides,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function createMockAgenticResponse(toolCalls: Array<{ name: string; input: unknown }>) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-opus-4-6",
    stop_reason: "tool_use" as const,
    content: toolCalls.map((tc) => ({
      type: "tool_use" as const,
      id: "tool_" + Math.random().toString(36).slice(2, 6),
      name: tc.name,
      input: tc.input,
    })),
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

const TEST_API_KEY = "test-anthropic-key";
const TEST_IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

const MOCK_LLM_CONTEXT = {
  _description: "LLM-friendly context",
  _usage: "Use this to discover services",
  services: [
    {
      service: "lead",
      baseUrl: "https://lead.example.com",
      title: "Lead Service",
      description: "Lead buffer management",
      endpoints: [
        { method: "POST", path: "/buffer/next", summary: "Get next lead" },
        { method: "POST", path: "/buffer/push", summary: "Push lead" },
      ],
    },
    {
      service: "campaign",
      baseUrl: "https://campaign.example.com",
      title: "Campaign Service",
      description: "Campaign lifecycle",
      endpoints: [
        { method: "POST", path: "/gate-check", summary: "Gate check" },
      ],
    },
  ],
};

const MOCK_SERVICE_SPEC = {
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
};

describe("generateWorkflow", () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCreate = vi.fn();
    setAnthropicClient({
      messages: { create: mockCreate },
    } as unknown as Anthropic);
    process.env.API_REGISTRY_SERVICE_URL = "http://fake-registry";
    process.env.API_REGISTRY_SERVICE_API_KEY = "test-key";
    mockFetchLlmContext.mockReset();
    mockFetchServiceSpec.mockReset();
    mockFetchLlmContext.mockResolvedValue(MOCK_LLM_CONTEXT);
    mockFetchServiceSpec.mockResolvedValue(MOCK_SERVICE_SPEC);
  });

  afterEach(() => {
    setAnthropicClient(null);
    delete process.env.API_REGISTRY_SERVICE_URL;
    delete process.env.API_REGISTRY_SERVICE_API_KEY;
  });

  it("throws if API_REGISTRY env vars are missing", async () => {
    delete process.env.API_REGISTRY_SERVICE_URL;
    delete process.env.API_REGISTRY_SERVICE_API_KEY;

    await expect(
      generateWorkflow({ description: "test" }, TEST_API_KEY, TEST_IDENTITY),
    ).rejects.toThrow("API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set");
  });

  it("returns valid DAG on first attempt", async () => {
    mockCreate.mockResolvedValueOnce(
      createMockToolResponse(VALID_LINEAR_DAG),
    );

    const result = await generateWorkflow(
      { description: "Search leads and send cold emails" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(result.category).toBe("sales");
    expect(result.channel).toBe("email");
    expect(result.audienceType).toBe("cold-outreach");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries with error feedback when DAG is invalid", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockCreate.mockResolvedValueOnce(createMockToolResponse(invalidDag));
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Search leads and send cold emails" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Verify retry message includes error context
    const retryCall = mockCreate.mock.calls[1][0];
    const lastMessage = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMessage.content[0].is_error).toBe(true);
  });

  it("throws GenerationValidationError after max retries", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    mockCreate.mockResolvedValue(createMockToolResponse(invalidDag));

    await expect(
      generateWorkflow({ description: "Bad workflow" }, TEST_API_KEY, TEST_IDENTITY),
    ).rejects.toThrow(GenerationValidationError);

    // 1 initial + 2 retries = 3 calls
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("passes hints to the user message", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow(
      {
        description: "Send email to leads",
        hints: {
          services: ["lead", "email-gateway"],
          expectedInputs: ["campaignId"],
        },
      },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages[0].content;
    expect(userMsg).toContain("lead, email-gateway");
    expect(userMsg).toContain("campaignId");
  });

  it("throws if LLM returns no tool use block", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text: "I cannot generate a workflow" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await expect(
      generateWorkflow({ description: "test workflow" }, TEST_API_KEY, TEST_IDENTITY),
    ).rejects.toThrow("LLM did not return a tool use response");
  });

  it("includes system prompt with DAG schema and service discovery", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_API_KEY, TEST_IDENTITY);

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("DAG Format");
    expect(call.system).toContain("http.call");
    expect(call.system).toContain("Service Discovery (MANDATORY)");
    expect(call.system).not.toContain("Available Services");
  });

  it("uses auto tool_choice", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_API_KEY, TEST_IDENTITY);

    const call = mockCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: "auto" });
  });

  it("provides all three tools", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_API_KEY, TEST_IDENTITY);

    const call = mockCreate.mock.calls[0][0];
    expect(call.tools).toHaveLength(3);
    const toolNames = call.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("list_services");
    expect(toolNames).toContain("get_service_endpoints");
    expect(toolNames).toContain("create_workflow");
  });

  it("resolves list_services then create_workflow across turns", async () => {
    // Turn 1: LLM calls list_services
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([{ name: "list_services", input: {} }]),
    );
    // Turn 2: LLM calls create_workflow with valid DAG
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Search leads and send cold emails" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockFetchLlmContext).toHaveBeenCalledTimes(1);
  });

  it("resolves list_services then get_service_endpoints then create_workflow", async () => {
    // Turn 1: list_services
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([{ name: "list_services", input: {} }]),
    );
    // Turn 2: get_service_endpoints for "lead"
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([{ name: "get_service_endpoints", input: { service: "lead" } }]),
    );
    // Turn 3: create_workflow
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Cold email outreach" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockFetchLlmContext).toHaveBeenCalledTimes(1);
    expect(mockFetchServiceSpec).toHaveBeenCalledWith("lead", TEST_IDENTITY);
  });

  it("handles multiple tool calls in a single turn", async () => {
    // Turn 1: LLM calls both list_services and get_service_endpoints in one response
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([
        { name: "list_services", input: {} },
        { name: "get_service_endpoints", input: { service: "lead" } },
      ]),
    );
    // Turn 2: create_workflow
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Cold email outreach" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockFetchLlmContext).toHaveBeenCalledTimes(1);
    expect(mockFetchServiceSpec).toHaveBeenCalledWith("lead", TEST_IDENTITY);
  });

  it("passes api-registry error to LLM as tool_result error", async () => {
    mockFetchLlmContext.mockRejectedValueOnce(new Error("api-registry error: connection refused"));

    // Turn 1: list_services (will fail)
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([{ name: "list_services", input: {} }]),
    );
    // Turn 2: LLM recovers and calls create_workflow
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Cold email outreach" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    // Verify the error was passed back to the LLM
    const turn2Call = mockCreate.mock.calls[1][0];
    const toolResultMsg = turn2Call.messages[2]; // user message with tool_result
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain("api-registry error");
  });

  it("throws when max agent turns exceeded without create_workflow", async () => {
    // LLM keeps calling list_services forever
    mockCreate.mockResolvedValue(
      createMockAgenticResponse([{ name: "list_services", input: {} }]),
    );

    await expect(
      generateWorkflow({ description: "Stuck workflow" }, TEST_API_KEY, TEST_IDENTITY),
    ).rejects.toThrow("Generation exceeded maximum turns without producing a workflow");
  });

  it("retries invalid DAG within agentic loop", async () => {
    const invalidDag = {
      nodes: [{ id: "a", type: "unknown-type-xyz" }],
      edges: [],
    };

    // Turn 1: list_services
    mockCreate.mockResolvedValueOnce(
      createMockAgenticResponse([{ name: "list_services", input: {} }]),
    );
    // Turn 2: create_workflow with invalid DAG
    mockCreate.mockResolvedValueOnce(createMockToolResponse(invalidDag));
    // Turn 3: create_workflow with valid DAG (after retry)
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    const result = await generateWorkflow(
      { description: "Cold email outreach" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    expect(result.dag).toEqual(VALID_LINEAR_DAG);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("uses 16384 max_tokens", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow({ description: "test workflow" }, TEST_API_KEY, TEST_IDENTITY);

    const call = mockCreate.mock.calls[0][0];
    expect(call.max_tokens).toBe(16384);
  });

  it("includes style directive in system prompt when style is provided", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow(
      {
        description: "Cold email outreach",
        style: { type: "human", name: "Hormozi", humanId: "human-123" },
      },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain("Style Directive");
    expect(call.system).toContain("Hormozi");
  });

  it("appends style to user message when style is provided", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow(
      {
        description: "Cold email outreach",
        style: { type: "brand", name: "My Brand", brandId: "brand-456" },
      },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages[0].content;
    expect(userMsg).toContain('Style: Generate this workflow in the style of "My Brand"');
  });

  it("does not include style in prompt when style is not provided", async () => {
    mockCreate.mockResolvedValueOnce(createMockToolResponse(VALID_LINEAR_DAG));

    await generateWorkflow(
      { description: "Cold email outreach" },
      TEST_API_KEY,
      TEST_IDENTITY,
    );

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).not.toContain("Style Directive");
    expect(call.messages[0].content).not.toContain("Style:");
  });
});
