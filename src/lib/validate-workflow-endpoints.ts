import type { DAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";

export interface InvalidEndpoint {
  service: string;
  method: string;
  path: string;
  reason: string;
}

export interface EndpointValidationResult {
  valid: boolean;
  invalidEndpoints: InvalidEndpoint[];
}

/**
 * Validates that every http.call endpoint in a DAG actually exists
 * in the corresponding service's OpenAPI spec.
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

  return {
    valid: invalidEndpoints.length === 0,
    invalidEndpoints,
  };
}
