import Anthropic from "@anthropic-ai/sdk";
import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildUpgradeSystemPrompt,
  buildRetryUserMessage,
  AGENTIC_TOOLS,
} from "./prompt-templates.js";
import {
  fetchLlmContext,
  fetchServiceSpec,
} from "./api-registry-client.js";
import type { IdentityHeaders } from "./key-service-client.js";
import type { InvalidEndpoint } from "./validate-workflow-endpoints.js";

const MAX_RETRIES = 2;
const MAX_AGENT_TURNS = 10;
const MODEL = "claude-opus-4-6";

let overrideClient: Anthropic | null = null;

/** Exported for testing — allows injecting a mock client */
export function setUpgradeAnthropicClient(client: Anthropic | null): void {
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

export interface UpgradeWorkflowResult {
  dag: DAG;
  category: string;
  channel: string;
  audienceType: string;
  description: string;
}

export async function upgradeWorkflow(
  currentDag: DAG,
  invalidEndpoints: InvalidEndpoint[],
  anthropicApiKey: string,
  identity: IdentityHeaders,
  metadata: { category: string; channel: string; audienceType: string; description: string },
): Promise<UpgradeWorkflowResult> {
  const client = overrideClient ?? new Anthropic({ apiKey: anthropicApiKey });

  const systemPrompt = buildUpgradeSystemPrompt({
    currentDag: currentDag as unknown as Record<string, unknown>,
    invalidEndpoints,
  });

  const tools = AGENTIC_TOOLS;

  const userMessage = `Fix this workflow. The category is "${metadata.category}", channel is "${metadata.channel}", audienceType is "${metadata.audienceType}". Description: "${metadata.description}". Only fix the broken endpoints listed above.`;

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
        throw new UpgradeValidationError(
          "Upgraded DAG is invalid after retries",
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
            content: buildRetryUserMessage(userMessage, validation.errors),
          },
        ],
      });
      continue;
    }

    // Resolve discovery tool calls
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      throw new Error("LLM did not return a tool use response during upgrade");
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

  throw new Error("Upgrade exceeded maximum turns without producing a corrected workflow");
}

export class UpgradeValidationError extends Error {
  public readonly validationErrors: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    errors: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "UpgradeValidationError";
    this.validationErrors = errors;
  }
}
