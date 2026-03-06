import Anthropic from "@anthropic-ai/sdk";
import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  AGENTIC_TOOLS,
} from "./prompt-templates.js";
import {
  fetchLlmContext,
  fetchServiceSpec,
} from "./api-registry-client.js";
import type { IdentityHeaders } from "./key-service-client.js";

export interface GenerateWorkflowInput {
  description: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
  };
  style?: {
    type: "human" | "brand";
    name: string;
    humanId?: string;
    brandId?: string;
  };
}

export interface GenerateWorkflowResult {
  dag: DAG;
  category: string;
  channel: string;
  audienceType: string;
  description: string;
}

const MAX_RETRIES = 2;
const MAX_AGENT_TURNS = 10;
const MODEL = "claude-opus-4-6";

let overrideClient: Anthropic | null = null;

/** Exported for testing — allows injecting a mock client */
export function setAnthropicClient(client: Anthropic | null): void {
  overrideClient = client;
}

async function resolveToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  identity: IdentityHeaders,
): Promise<{ content: string; isError?: boolean }> {
  switch (toolName) {
    case "list_services": {
      const context = await fetchLlmContext(identity);
      const summary = context.services.map((s) => ({
        name: s.service,
        description: s.description ?? s.title ?? "",
        endpointCount: s.endpoints.length,
        endpoints: s.endpoints.map((e) => `${e.method} ${e.path}`),
      }));
      return { content: JSON.stringify(summary, null, 2) };
    }
    case "get_service_endpoints": {
      const serviceName = toolInput.service as string;
      const spec = await fetchServiceSpec(serviceName, identity);
      return { content: JSON.stringify(spec, null, 2) };
    }
    default:
      return { content: `Unknown tool: ${toolName}`, isError: true };
  }
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
  anthropicApiKey: string,
  identity: IdentityHeaders,
): Promise<GenerateWorkflowResult> {
  if (!process.env.API_REGISTRY_SERVICE_URL || !process.env.API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set to generate workflows",
    );
  }

  const client = overrideClient ?? new Anthropic({ apiKey: anthropicApiKey });

  const styleDirective = input.style
    ? `This workflow MUST be created in the style of ${input.style.name}. Adopt their methodology, tone, and strategic patterns.`
    : undefined;

  const systemPrompt = buildSystemPrompt({ styleDirective });

  const tools = AGENTIC_TOOLS;

  let userMessage = input.description;
  if (input.hints?.services?.length) {
    userMessage += `\n\nRelevant services: ${input.hints.services.join(", ")}`;
  }
  if (input.hints?.nodeTypes?.length) {
    userMessage += `\nPreferred node types: ${input.hints.nodeTypes.join(", ")}`;
  }
  if (input.hints?.expectedInputs?.length) {
    userMessage += `\nExpected flow_input fields: ${input.hints.expectedInputs.join(", ")}`;
  }
  if (input.style) {
    userMessage += `\n\nStyle: Generate this workflow in the style of "${input.style.name}".`;
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let dagRetries = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16384,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: "auto" as const },
    });

    // Check if the response contains a create_workflow call
    const createWorkflowCall = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === "create_workflow",
    );

    if (createWorkflowCall) {
      const result = createWorkflowCall.input as {
        category: string;
        channel: string;
        audienceType: string;
        description: string;
        dag: DAG;
      };

      const validation = validateDAG(result.dag);

      if (validation.valid) {
        return {
          dag: result.dag,
          category: result.category,
          channel: result.channel,
          audienceType: result.audienceType,
          description: result.description,
        };
      }

      dagRetries++;
      if (dagRetries > MAX_RETRIES) {
        throw new GenerationValidationError(
          "Generated DAG is invalid after retries",
          validation.errors,
        );
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: createWorkflowCall.id,
            is_error: true,
            content: buildRetryUserMessage(input.description, validation.errors),
          },
        ],
      });
      continue;
    }

    // No create_workflow — resolve discovery tool calls (list_services, get_service_endpoints)
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      throw new Error("LLM did not return a tool use response");
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolBlock of toolUseBlocks) {
      try {
        const resolved = await resolveToolCall(
          toolBlock.name,
          toolBlock.input as Record<string, unknown>,
          identity,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: resolved.content,
          ...(resolved.isError ? { is_error: true } : {}),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Generation exceeded maximum turns without producing a workflow");
}

export class GenerationValidationError extends Error {
  public readonly validationErrors: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    errors: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "GenerationValidationError";
    this.validationErrors = errors;
  }
}
