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
    id: z.string().min(1),
    type: z.string().min(1),
    config: z.record(z.unknown()).optional(),
    inputMapping: z.record(z.string()).optional(),
  })
  .openapi("DAGNode");

export const DAGEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    condition: z.string().optional(),
  })
  .openapi("DAGEdge");

export const DAGSchema = z
  .object({
    nodes: z.array(DAGNodeSchema).min(1),
    edges: z.array(DAGEdgeSchema),
  })
  .openapi("DAG");

// --- Workflow schemas ---

export const CreateWorkflowSchema = z
  .object({
    orgId: z.string().min(1),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    subrequestId: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
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
    id: z.string().uuid(),
    appId: z.string().nullable(),
    orgId: z.string(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    dag: z.unknown(),
    windmillFlowPath: z.string().nullable(),
    windmillWorkspace: z.string(),
    status: z.string(),
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
    inputs: z.record(z.unknown()).optional(),
    runId: z.string().optional(),
  })
  .openapi("ExecuteWorkflowRequest");

export const WorkflowRunResponseSchema = z
  .object({
    id: z.string().uuid(),
    workflowId: z.string().uuid().nullable(),
    orgId: z.string(),
    campaignId: z.string().nullable(),
    subrequestId: z.string().nullable(),
    runId: z.string().nullable(),
    windmillJobId: z.string().nullable(),
    windmillWorkspace: z.string(),
    status: z.string(),
    inputs: z.unknown().nullable(),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("WorkflowRunResponse");

// --- Deploy schemas ---

export const DeployWorkflowItemSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    dag: DAGSchema,
  })
  .openapi("DeployWorkflowItem");

export const DeployWorkflowsSchema = z
  .object({
    appId: z.string().min(1),
    workflows: z.array(DeployWorkflowItemSchema).min(1),
  })
  .openapi("DeployWorkflowsRequest");

export const DeployWorkflowResultSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
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
    appId: z.string().min(1),
    orgId: z.string().optional(),
    inputs: z.record(z.unknown()).optional(),
    runId: z.string().optional(),
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
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
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
