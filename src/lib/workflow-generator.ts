import { validateDAG, type DAG } from "./dag-validator.js";
import {
  buildSystemPrompt,
  buildRetryUserMessage,
  type ServiceContext,
} from "./prompt-templates.js";
import {
  fetchLlmContext,
  fetchSpecsForServices,
} from "./api-registry-client.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import type { DownstreamHeaders } from "./downstream-headers.js";
import {
  WorkflowCategorySchema,
  WorkflowChannelSchema,
  WorkflowAudienceTypeSchema,
} from "../schemas.js";
import {
  chatServiceComplete,
  type ChatServiceCompleteRequest,
  type ChatServiceCompleteResponse,
} from "./chat-service-client.js";

export interface GenerateWorkflowInput {
  description: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
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

let overrideCompleteFn: ((req: ChatServiceCompleteRequest, h: DownstreamHeaders) => Promise<ChatServiceCompleteResponse>) | null = null;

/** Exported for testing — allows injecting a mock chat-service client */
export function setChatServiceClient(fn: typeof overrideCompleteFn): void {
  overrideCompleteFn = fn;
}

async function callComplete(
  request: ChatServiceCompleteRequest,
  downstreamHeaders: DownstreamHeaders,
): Promise<ChatServiceCompleteResponse> {
  if (overrideCompleteFn) return overrideCompleteFn(request, downstreamHeaders);
  return chatServiceComplete(request, downstreamHeaders);
}

// api-service is a proxy — the prompt forbids `service: "api"`. Filter it out of
// the registry context entirely so the LLM cannot see api-service paths and
// copy them onto another service's call (e.g. /v1/campaigns/pipeline/gate-check
// being attached to service="campaign"), which would otherwise 422 on validation.
const HIDDEN_SERVICES = new Set(["api"]);

async function fetchServiceContext(downstreamHeaders: DownstreamHeaders): Promise<ServiceContext> {
  const context = await fetchLlmContext(downstreamHeaders);
  const visibleServices = context.services.filter(
    (s: { service: string }) => !HIDDEN_SERVICES.has(s.service),
  );
  const serviceNames = visibleServices.map((s: { service: string }) => s.service);
  const specsMap = await fetchSpecsForServices(serviceNames, downstreamHeaders);

  const specs: Record<string, unknown> = {};
  for (const [name, spec] of specsMap) {
    if (HIDDEN_SERVICES.has(name)) continue;
    specs[name] = spec;
  }

  return {
    services: visibleServices.map((s: { service: string; description?: string; endpointCount: number }) => ({
      name: s.service,
      description: s.description ?? "",
      endpointCount: s.endpointCount,
    })),
    specs,
  };
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
  downstreamHeaders: DownstreamHeaders,
): Promise<GenerateWorkflowResult> {
  if (!process.env.API_REGISTRY_SERVICE_URL || !process.env.API_REGISTRY_SERVICE_API_KEY) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set to generate workflows",
    );
  }

  // Pre-fetch all service context upfront
  const serviceContext = await fetchServiceContext(downstreamHeaders);

  const systemPrompt = buildSystemPrompt({ serviceContext });

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await callComplete(
      {
        message: userMessage,
        systemPrompt,
        responseFormat: "json",
        maxTokens: 16384,
        provider: "google",
        model: "pro",
      },
      downstreamHeaders,
    );

    if (!response.json) {
      throw new Error("LLM did not return valid JSON");
    }

    const result = response.json as {
      category: string;
      channel: string;
      audienceType: string;
      description: string;
      dag: DAG;
    };

    const validation = validateDAG(result.dag);

    if (validation.valid) {
      // Also validate endpoint fields against API registry
      const httpEndpoints = extractHttpEndpoints(result.dag);
      if (httpEndpoints.length > 0) {
        try {
          const serviceNames = [...new Set(httpEndpoints.map((e) => e.service))];
          const specs = await fetchSpecsForServices(serviceNames, downstreamHeaders);
          const endpointResult = validateWorkflowEndpoints(result.dag, specs);

          if (!endpointResult.valid) {
            const fieldErrors = [
              ...endpointResult.invalidEndpoints.map((e) => ({
                field: `${e.method} ${e.service}${e.path}`,
                message: e.reason,
              })),
              ...endpointResult.fieldIssues
                .filter((f) => f.severity === "error")
                .map((f) => ({
                  field: `nodes[${f.nodeId}].${f.field}`,
                  message: f.reason,
                })),
            ];

            if (attempt >= MAX_RETRIES) {
              throw new GenerationValidationError(
                "Generated DAG has invalid endpoint fields after retries",
                fieldErrors,
              );
            }

            userMessage = buildRetryUserMessage(input.description, fieldErrors);
            continue;
          }
        } catch (err) {
          if (err instanceof GenerationValidationError) throw err;
          console.warn("[workflow-service] generate: field validation skipped:", err);
        }
      }

      // The three tags are stored verbatim, so a value the model invents becomes a permanent,
      // false claim about the workflow. Judge them against the same enums the API publishes.
      const tagErrors = validateDimensionTags(result);
      if (tagErrors.length > 0) {
        if (attempt >= MAX_RETRIES) {
          throw new GenerationValidationError(
            "Generated workflow carries dimension tags outside the published vocabulary",
            tagErrors,
          );
        }
        userMessage = buildRetryUserMessage(input.description, tagErrors);
        continue;
      }

      return {
        dag: result.dag,
        category: result.category,
        channel: result.channel,
        audienceType: result.audienceType,
        description: result.description,
      };
    }

    if (attempt >= MAX_RETRIES) {
      throw new GenerationValidationError(
        "Generated DAG is invalid after retries",
        validation.errors,
      );
    }

    userMessage = buildRetryUserMessage(input.description, validation.errors);
  }

  throw new Error("Generation exceeded maximum retries without producing a workflow");
}

/**
 * Checks the model's three descriptive tags against the published enums.
 *
 * They are provenance — nothing branches on them — which is exactly why a wrong value survives:
 * it never breaks anything and it outlives whoever wrote it.
 */
function validateDimensionTags(result: {
  category: string;
  channel: string;
  audienceType: string;
}): Array<{ field: string; message: string }> {
  const checks = [
    { field: "category", value: result.category, schema: WorkflowCategorySchema },
    { field: "channel", value: result.channel, schema: WorkflowChannelSchema },
    { field: "audienceType", value: result.audienceType, schema: WorkflowAudienceTypeSchema },
  ] as const;

  return checks.flatMap(({ field, value, schema }) => {
    if (schema.safeParse(value).success) return [];
    return [
      {
        field,
        message: `"${String(value)}" is not a valid ${field}. Allowed: ${schema.options
          .map((option: string) => `"${option}"`)
          .join(" | ")}.`,
      },
    ];
  });
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
