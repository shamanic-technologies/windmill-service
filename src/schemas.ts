import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security scheme ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

// --- DAG schemas ---

export const DAGNodeSchema = z
  .object({
    id: z.string().min(1).describe("Unique identifier for this node within the DAG. Used in edges and $ref input mappings."),
    type: z.string().min(1).describe(
      "Node type. Use \"http.call\" to call any microservice (recommended), or a specific node type. " +
      "http.call config requires: service (name, e.g. \"stripe\"), method (HTTP verb), path (endpoint path). " +
      "Native flow control types: " +
      "\"condition\" — if/then/else branching (uses Windmill branchone). " +
      "Outgoing edges with 'condition' define branches; nodes downstream of a conditional edge are nested inside that branch. " +
      "Outgoing edges without 'condition' define after-branch steps that always execute. " +
      "\"wait\" — sleep/delay. \"for-each\" — loop over items (body nodes are nested inside the loop). " +
      "Legacy named types: stripe.createProduct, client.createUser, transactional-email.send."
    ),
    config: z.record(z.unknown()).optional().describe(
      "Static parameters passed to the node. For http.call: { service, method, path, body?, query?, headers? }. " +
      "For wait: { seconds }. For for-each: { iterator, parallel?, skipFailures? }. " +
      "Each key becomes a direct parameter of the underlying script. " +
      "Special config keys (stripped before passing to script): " +
      "retries (number) — override default retry count; " +
      "validateResponse ({ field, equals }) — throw error if response[field] !== equals, triggers onError handler; " +
      "stopAfterIf (string) — native Windmill stop_after_if. JS expression evaluated after step completes using 'result' variable, " +
      "stops the entire flow gracefully (no onError, no subsequent steps) when true. Example: \"result.found == false\". " +
      "For conditional branching (run some steps but not others), use a \"condition\" node instead; " +
      "skipIf (string) — native Windmill skip_if. JS expression evaluated before this step runs, " +
      "skips only this step when true. Can reference previous results via results.<module_id>. " +
      "Example: \"results.fetch_lead.found == false\". For multi-step skipping, prefer a \"condition\" node."
    ),
    inputMapping: z.record(z.string()).optional().describe(
      "Dynamic input references using $ref syntax. " +
      "Use \"$ref:flow_input.fieldName\" for workflow execution inputs, " +
      "or \"$ref:node-id.output.fieldName\" for a previous node's output. " +
      "Keys in inputMapping override same-named keys in config."
    ),
    retries: z.number().int().min(0).optional().describe(
      "Number of retry attempts on failure. Defaults to 3 if omitted. " +
      "Set to 0 for non-idempotent operations (e.g., sending emails, consuming queue items) to prevent duplicates."
    ),
  })
  .openapi("DAGNode");

export const DAGEdgeSchema = z
  .object({
    from: z.string().min(1).describe("Source node ID — this node runs first."),
    to: z.string().min(1).describe("Target node ID — runs after the source completes."),
    condition: z.string().optional().describe(
      "JavaScript expression for conditional branching. Only used when source node is type \"condition\". " +
      "Edges WITH condition: target node (and its chain) are nested inside that branch — they only execute when the condition is true. " +
      "Edges WITHOUT condition from a condition node: target is an after-branch step that always executes. " +
      "Expressions can reference previous results (results.<module_id>.<field>) or flow_input. " +
      "Example: \"results.fetch_lead.found == true\""
    ),
  })
  .openapi("DAGEdge");

export const DAGSchema = z
  .object({
    nodes: z.array(DAGNodeSchema).min(1).describe("The steps of the workflow. Must contain at least one node."),
    edges: z.array(DAGEdgeSchema).describe("Execution order between nodes. Empty array for single-node workflows."),
    onError: z.string().optional().describe(
      "Node ID of an error handler that runs when any node in the DAG fails (including validateResponse failures). " +
      "Auto-injected parameters (available as script params, no inputMapping needed): " +
      "failedNodeId (string) — the module ID of the step that failed; " +
      "errorMessage (string) — the error message text. " +
      "Can also access outputs from previously completed nodes via $ref syntax. " +
      "Use this to call end-run with success: false. " +
      "Tip: check errorMessage to distinguish expected stops (e.g. 'validation failed: expected found=true') from real errors."
    ),
  })
  .openapi("DAG");

// --- Workflow enums ---

export const WorkflowCategorySchema = z
  .enum(["sales", "pr"])
  .describe("Workflow category.")
  .openapi("WorkflowCategory");

// --- Workflow schemas ---

export const CreateWorkflowSchema = z
  .object({
    orgId: z.string().min(1).describe("Organization ID that owns this workflow."),
    brandId: z.string().optional().describe("Optional brand ID for scoping."),
    campaignId: z.string().optional().describe("Optional campaign ID for scoping."),
    subrequestId: z.string().optional().describe("Optional subrequest ID for cost tracking."),
    name: z.string().min(1).describe("Workflow name. Must be unique within the orgId. Used to execute by name later."),
    description: z.string().optional().describe("Human-readable description of what this workflow does."),
    dag: DAGSchema,
  })
  .openapi("CreateWorkflowRequest");

export const UpdateWorkflowSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    dag: DAGSchema.optional(),
  })
  .openapi("UpdateWorkflowRequest");

export const WorkflowResponseSchema = z
  .object({
    id: z.string().uuid().describe("Workflow UUID. Not needed for execution — use name + appId instead."),
    appId: z.string().nullable().describe("App ID (set via deploy endpoint)."),
    orgId: z.string().describe("Organization ID."),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    name: z.string().describe("Workflow name. Use this with appId to execute via /workflows/by-name/{name}/execute."),
    displayName: z.string().nullable().describe("Human-readable display name. Falls back to name if not set."),
    description: z.string().nullable(),
    category: WorkflowCategorySchema.nullable().describe("Workflow category (sales, pr)."),
    dag: z.unknown().describe("The DAG definition as submitted."),
    windmillFlowPath: z.string().nullable().describe("Internal Windmill flow path (managed automatically)."),
    windmillWorkspace: z.string().describe("Windmill workspace (managed automatically)."),
    status: z.string().describe("Workflow status: active or deleted."),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("WorkflowResponse");

export const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional(),
  })
  .openapi("ValidationResult");

// --- Workflow Run schemas ---

export const ExecuteWorkflowSchema = z
  .object({
    appId: z.string().optional().describe(
      "App ID override. If not provided, falls back to the workflow's stored appId."
    ),
    inputs: z.record(z.unknown()).optional().describe(
      "Runtime inputs for the workflow. Accessible in nodes via $ref:flow_input.fieldName."
    ),
    runId: z.string().optional().describe("Optional external run ID for cost tracking via runs-service."),
  })
  .openapi("ExecuteWorkflowRequest");

export const WorkflowRunResponseSchema = z
  .object({
    id: z.string().uuid().describe("Run UUID. Use this to poll status via GET /workflow-runs/{id}."),
    workflowId: z.string().uuid().nullable(),
    orgId: z.string(),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    runId: z.string().nullable().describe("External run ID (if provided at execution time)."),
    windmillJobId: z.string().nullable().describe("Internal Windmill job ID (managed automatically)."),
    windmillWorkspace: z.string(),
    status: z.string().describe("Run status: queued, running, completed, failed, or cancelled."),
    inputs: z.unknown().nullable().describe("The inputs that were passed at execution time."),
    result: z.unknown().nullable().describe("Workflow result (available when status is completed). Contains the output of the last node."),
    error: z.string().nullable().describe("Error message (available when status is failed)."),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("WorkflowRunResponse");

// --- Deploy schemas ---

export const DeployWorkflowItemSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "name must be a lowercase slug (letters, digits, hyphens, cannot start with hyphen)").describe("Workflow name (slug). Must be unique within the appId. Used to execute via /workflows/by-name/{name}/execute."),
    displayName: z.string().optional().describe("Human-readable display name for dashboards. Falls back to name if not set."),
    description: z.string().optional().describe("Human-readable description."),
    category: WorkflowCategorySchema.optional().describe("Workflow category."),
    dag: DAGSchema,
  })
  .openapi("DeployWorkflowItem");

export const DeployWorkflowsSchema = z
  .object({
    appId: z.string().min(1).describe(
      "Your application identifier. Workflows are scoped to (appId + name). " +
      "Use the same appId when executing. This is idempotent — existing workflows with the same name are updated."
    ),
    workflows: z.array(DeployWorkflowItemSchema).min(1).describe("The workflows to deploy."),
  })
  .openapi("DeployWorkflowsRequest");

export const DeployWorkflowResultSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    displayName: z.string().nullable(),
    category: WorkflowCategorySchema.nullable(),
    action: z.enum(["created", "updated"]),
  })
  .openapi("DeployWorkflowResult");

export const DeployWorkflowsResponseSchema = z
  .object({
    workflows: z.array(DeployWorkflowResultSchema),
  })
  .openapi("DeployWorkflowsResponse");

// --- Execute by name schema ---

export const ExecuteByNameSchema = z
  .object({
    appId: z.string().min(1).describe("Must match the appId used during deploy."),
    orgId: z.string().optional().describe("Organization ID for this execution (overrides workflow's orgId if set)."),
    inputs: z.record(z.unknown()).optional().describe(
      "Runtime inputs for the workflow. Accessible in nodes via $ref:flow_input.fieldName."
    ),
    runId: z.string().optional().describe("Optional external run ID for cost tracking via runs-service."),
  })
  .openapi("ExecuteByNameRequest");

// --- Common ---

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.unknown().optional(),
  })
  .openapi("ErrorResponse");

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
    windmill: z.string().optional(),
    db: z.string().optional(),
  })
  .openapi("HealthResponse");

// --- Register Paths ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  tags: ["Health"],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows",
  summary: "Create a new workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkflowSchema } },
    },
  },
  responses: {
    201: {
      description: "Workflow created",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows",
  summary: "List workflows",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      orgId: z.string(),
      appId: z.string().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      category: WorkflowCategorySchema.optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of workflows",
      content: {
        "application/json": {
          schema: z.object({ workflows: z.array(WorkflowResponseSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflows/{id}",
  summary: "Get a workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow found",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/{id}",
  summary: "Update a workflow",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkflowSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflow updated",
      content: { "application/json": { schema: WorkflowResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/workflows/{id}",
  summary: "Delete a workflow (soft delete)",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/validate",
  summary: "Validate a workflow DAG",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Validation result",
      content: { "application/json": { schema: ValidationResultSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/{id}/execute",
  summary: "Execute a workflow",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: false,
      content: { "application/json": { schema: ExecuteWorkflowSchema } },
    },
  },
  responses: {
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflow-runs/{id}",
  summary: "Get a workflow run",
  description: "Returns the current status and result of a workflow execution. If still running, polls the engine for the latest status before responding.",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Workflow run",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

export const WorkflowRunDebugResponseSchema = z
  .object({
    runId: z.string().uuid(),
    windmillJobId: z.string(),
    status: z.string(),
    flowStatus: z.unknown().nullable().describe(
      "Windmill flow_status object. Contains per-module execution details including " +
      "resolved inputs, outputs, and timing for each step in the flow."
    ),
    result: z.unknown().nullable().describe("Final flow result."),
  })
  .openapi("WorkflowRunDebugResponse");

registry.registerPath({
  method: "get",
  path: "/workflow-runs/{id}/debug",
  summary: "Debug a workflow run",
  description:
    "Returns per-step execution details from the Windmill engine, including " +
    "resolved inputs and outputs for each module. Use this to diagnose " +
    "runtime issues that aren't visible in the final result.",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Debug details",
      content: {
        "application/json": { schema: WorkflowRunDebugResponseSchema },
      },
    },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/workflow-runs",
  summary: "List workflow runs",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      workflowId: z.string().uuid().optional(),
      orgId: z.string().optional(),
      campaignId: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of runs",
      content: {
        "application/json": {
          schema: z.object({
            workflowRuns: z.array(WorkflowRunResponseSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflow-runs/{id}/cancel",
  summary: "Cancel a workflow run",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Run cancelled",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/workflows/deploy",
  summary: "Deploy (upsert) workflows by name",
  description:
    "Idempotent: creates new workflows or updates existing ones matched by (appId + name). " +
    "Call this at app startup to register all your workflows. " +
    "After deploying, execute workflows via POST /workflows/by-name/{name}/execute.",
  tags: ["Workflows"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: DeployWorkflowsSchema } },
    },
  },
  responses: {
    200: {
      description: "Workflows deployed",
      content: {
        "application/json": { schema: DeployWorkflowsResponseSchema },
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/workflows/by-name/{name}/execute",
  summary: "Execute a workflow by name",
  description:
    "Starts an async execution of a previously deployed workflow. " +
    "Returns a run object with an ID — poll GET /workflow-runs/{id} for status (queued → running → completed/failed). " +
    "Pass runtime data via inputs (accessible in nodes as $ref:flow_input.fieldName).",
  tags: ["Workflow Runs"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ name: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: ExecuteByNameSchema } },
    },
  },
  responses: {
    201: {
      description: "Execution started",
      content: {
        "application/json": { schema: WorkflowRunResponseSchema },
      },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI specification",
  tags: ["Health"],
  responses: {
    200: {
      description: "OpenAPI spec",
      content: { "application/json": { schema: z.unknown() } },
    },
  },
});
