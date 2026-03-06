import type { DAG, DAGNode } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { getRequestBodySchema, getResponseSchema } from "./openapi-schema-resolver.js";

export interface InvalidEndpoint {
  service: string;
  method: string;
  path: string;
  reason: string;
}

export interface FieldValidationIssue {
  nodeId: string;
  service: string;
  method: string;
  path: string;
  field: string;
  severity: "error" | "warning";
  reason: string;
}

export interface EndpointValidationResult {
  valid: boolean;
  invalidEndpoints: InvalidEndpoint[];
  fieldIssues: FieldValidationIssue[];
}

/**
 * Validates that every http.call endpoint in a DAG actually exists
 * in the corresponding service's OpenAPI spec, and that body fields
 * match the endpoint's request schema.
 */
export function validateWorkflowEndpoints(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
): EndpointValidationResult {
  const endpoints = extractHttpEndpoints(dag);
  const invalidEndpoints: InvalidEndpoint[] = [];

  for (const ep of endpoints) {
    const spec = specs.get(ep.service);

    if (!spec) {
      invalidEndpoints.push({
        ...ep,
        reason: `Service "${ep.service}" not found in API Registry`,
      });
      continue;
    }

    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
    if (!paths) {
      invalidEndpoints.push({
        ...ep,
        reason: `Service "${ep.service}" has no paths in its OpenAPI spec`,
      });
      continue;
    }

    const pathEntry = paths[ep.path];
    if (!pathEntry) {
      invalidEndpoints.push({
        ...ep,
        reason: `Path "${ep.path}" not found in ${ep.service} spec`,
      });
      continue;
    }

    const methodEntry = pathEntry[ep.method.toLowerCase()];
    if (!methodEntry) {
      invalidEndpoints.push({
        ...ep,
        reason: `Method ${ep.method} not found for path "${ep.path}" in ${ep.service} spec`,
      });
      continue;
    }
  }

  // Second pass: field-level validation
  const fieldIssues = validateFields(dag, specs);
  const hasFieldErrors = fieldIssues.some((i) => i.severity === "error");

  return {
    valid: invalidEndpoints.length === 0 && !hasFieldErrors,
    invalidEndpoints,
    fieldIssues,
  };
}

/**
 * Extracts the body field names a node will send to its endpoint.
 * Sources: config.body (static keys) + inputMapping "body.*" keys.
 */
export function extractBodyFields(node: DAGNode): string[] {
  const fields = new Set<string>();

  // Static body fields from config.body
  const body = node.config?.body;
  if (body && typeof body === "object" && body !== null) {
    for (const key of Object.keys(body as Record<string, unknown>)) {
      fields.add(key);
    }
  }

  // Dynamic body fields from inputMapping "body.*"
  if (node.inputMapping) {
    for (const key of Object.keys(node.inputMapping)) {
      if (key.startsWith("body.")) {
        // "body.campaignId" → "campaignId"
        // "body.metadata.field" → "metadata" (top-level key only)
        const rest = key.slice(5);
        const topLevel = rest.split(".")[0];
        if (topLevel) fields.add(topLevel);
      }
    }
  }

  return [...fields];
}

/**
 * Finds all downstream $ref:nodeId.output.field references for a given source node.
 */
export function extractOutputRefs(
  dag: DAG,
  sourceNodeId: string,
): Array<{ downstreamNodeId: string; field: string }> {
  const refs: Array<{ downstreamNodeId: string; field: string }> = [];
  const normalizedId = sourceNodeId.replace(/-/g, "_");
  const hyphenId = sourceNodeId;

  for (const node of dag.nodes) {
    if (!node.inputMapping) continue;

    for (const ref of Object.values(node.inputMapping)) {
      if (typeof ref !== "string" || !ref.startsWith("$ref:")) continue;

      const path = ref.replace("$ref:", "");
      // Match both "node-id.output.field" and "node-id.field" patterns
      const parts = path.split(".");
      const refNodeId = parts[0];
      if (refNodeId !== hyphenId && refNodeId !== normalizedId) continue;

      // Skip "output" keyword, get the actual field name
      const rest = parts.slice(1).filter((p) => p !== "output");
      if (rest.length > 0) {
        refs.push({ downstreamNodeId: node.id, field: rest[0] });
      }
      // If rest.length === 0, it's a whole-output reference — skip validation
    }
  }

  return refs;
}

function validateFields(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];

  for (const node of dag.nodes) {
    if (node.type !== "http.call") continue;
    if (!node.config) continue;

    const { service, method, path } = node.config;
    if (typeof service !== "string" || typeof method !== "string" || typeof path !== "string") continue;

    const spec = specs.get(service);
    if (!spec) continue; // Already reported as invalidEndpoint

    // --- Input (body) field validation ---
    // Skip if body is passed as a whole object (not field-by-field)
    const hasWholeBodyMapping = node.inputMapping?.body !== undefined &&
      typeof node.inputMapping.body === "string";

    if (!hasWholeBodyMapping) {
      const requestSchema = getRequestBodySchema(spec, path, method);
      if (requestSchema) {
        const bodyFields = extractBodyFields(node);

        // Unknown body fields → warning
        for (const field of bodyFields) {
          if (!requestSchema.properties[field]) {
            issues.push({
              nodeId: node.id,
              service, method, path, field,
              severity: "warning",
              reason: `Body field "${field}" not in ${service} ${method} ${path} schema (expected: ${Object.keys(requestSchema.properties).join(", ")})`,
            });
          }
        }

        // Missing required fields → error
        for (const required of requestSchema.required) {
          if (!bodyFields.includes(required)) {
            issues.push({
              nodeId: node.id,
              service, method, path, field: required,
              severity: "error",
              reason: `Required field "${required}" missing from node "${node.id}" for ${service} ${method} ${path}`,
            });
          }
        }
      }
    }

    // --- Output field validation ---
    const responseSchema = getResponseSchema(spec, path, method);
    if (responseSchema) {
      const outputRefs = extractOutputRefs(dag, node.id);
      for (const ref of outputRefs) {
        if (!responseSchema.properties[ref.field]) {
          issues.push({
            nodeId: node.id,
            service, method, path, field: ref.field,
            severity: "warning",
            reason: `Output field "${ref.field}" referenced by "${ref.downstreamNodeId}" not in ${service} ${method} ${path} response schema`,
          });
        }
      }
    }
  }

  return issues;
}
