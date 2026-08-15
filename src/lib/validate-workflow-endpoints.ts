import type { DAG, DAGNode } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import {
  getRequestBodySchema,
  getResponseSchema,
  getSchemaAtPath,
  walkSchemaPath,
} from "./openapi-schema-resolver.js";

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

export interface LiteralBodyValue {
  /** Path segments under the request body, e.g. ["model"] or ["options", "tone"] */
  path: string[];
  value: unknown;
}

/**
 * Collects the request-body values a node states LITERALLY in its DAG.
 *
 * Only literals can be judged against a downstream schema: anything that
 * resolves at run time from an upstream node ($ref) is unknowable here and is
 * deliberately left out — including every path a $ref overrides, since the
 * static base is replaced by the reference at dispatch (see collapseDotNotation
 * in input-mapping.ts).
 */
export function extractLiteralBodyValues(node: DAGNode): LiteralBodyValue[] {
  // Whole-body mapping: the entire body comes from a reference, nothing literal.
  if (typeof node.inputMapping?.body === "string") return [];

  // Paths supplied at run time — these, and anything nested under them, are unjudged.
  const dynamicPaths: string[][] = [];
  for (const [key, ref] of Object.entries(node.inputMapping ?? {})) {
    if (!key.startsWith("body.")) continue;
    if (typeof ref === "string" && ref.startsWith("$ref:")) {
      dynamicPaths.push(key.slice(5).split("."));
    }
  }

  const isDynamic = (path: string[]): boolean =>
    dynamicPaths.some((dyn) => dyn.every((seg, i) => path[i] === seg));

  const literals: LiteralBodyValue[] = [];

  const walk = (value: unknown, path: string[]): void => {
    if (path.length > 0 && isDynamic(path)) return;
    if (isPlainObject(value)) {
      for (const [key, sub] of Object.entries(value)) {
        walk(sub, [...path, key]);
      }
      return;
    }
    if (path.length > 0) literals.push({ path, value });
  };

  walk(node.config?.body, []);

  // Dot-notation literals: inputMapping "body.model": "pro" is static too.
  for (const [key, ref] of Object.entries(node.inputMapping ?? {})) {
    if (!key.startsWith("body.")) continue;
    if (typeof ref === "string" && ref.startsWith("$ref:")) continue;
    walk(ref, key.slice(5).split("."));
  }

  return literals;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a literal value against a leaf schema's closed set of permitted values.
 * Returns a human-readable violation, or null when the schema permits the value
 * — or says nothing about it, which means unconstrained.
 */
export function checkLiteralAgainstSchema(
  leaf: Record<string, unknown>,
  value: unknown,
): { value: unknown; permitted: unknown[] } | null {
  if ("const" in leaf) {
    return leaf.const === value ? null : { value, permitted: [leaf.const] };
  }

  // Array-valued field whose ITEMS declare the closed set.
  if (Array.isArray(value)) {
    const items = leaf.items;
    if (!isPlainObject(items)) return null;
    for (const element of value) {
      const violation = checkLiteralAgainstSchema(items, element);
      if (violation) return violation;
    }
    return null;
  }

  const permitted = leaf.enum;
  if (!Array.isArray(permitted) || permitted.length === 0) return null;

  // Only scalars are comparable against a scalar enum; a shape mismatch is a
  // different question and not one this check answers.
  if (value !== null && typeof value === "object") return null;
  if (value === null && leaf.nullable === true) return null;

  return permitted.includes(value) ? null : { value, permitted };
}

/**
 * Finds all downstream $ref:nodeId.output.field references for a given source node.
 */
export function extractOutputRefs(
  dag: DAG,
  sourceNodeId: string,
): Array<{ downstreamNodeId: string; field: string; fullPath: string[] }> {
  const refs: Array<{ downstreamNodeId: string; field: string; fullPath: string[] }> = [];
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

      // Skip "output" keyword, get the actual field path
      const rest = parts.slice(1).filter((p) => p !== "output");
      if (rest.length > 0) {
        refs.push({ downstreamNodeId: node.id, field: rest[0], fullPath: rest });
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

    const requestSchema = getRequestBodySchema(spec, path, method);

    if (!hasWholeBodyMapping) {
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

        // Literal body values outside the closed set the schema permits → error.
        // A value the schema says nothing about is unconstrained, and a value
        // that arrives from an upstream node at run time is not judged at all.
        for (const literal of extractLiteralBodyValues(node)) {
          const leaf = getSchemaAtPath(requestSchema, literal.path, spec);
          if (!leaf) continue;

          const violation = checkLiteralAgainstSchema(leaf, literal.value);
          if (!violation) continue;

          const field = literal.path.join(".");
          issues.push({
            nodeId: node.id,
            service, method, path, field,
            severity: "error",
            reason: `Body field "${field}" in node "${node.id}" has value ${JSON.stringify(violation.value)}, which ${service} ${method} ${path} does not permit (allowed: ${violation.permitted.map((v) => JSON.stringify(v)).join(", ")})`,
          });
        }
      }
    }

    // Object/array-valued template variables (body.variables.*) are a
    // first-class, intended input on this platform (multibrand). The
    // content-generation /generate + /generate-expert-quote-pitch endpoints
    // render objects/arrays as markdown into the prompt, so there is no
    // "flat scalars only" rule to enforce here.

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
          continue;
        }

        // Deep path validation: check nested fields (e.g. lead.firstName vs lead.data.firstName)
        if (ref.fullPath.length > 1) {
          const walkResult = walkSchemaPath(responseSchema, ref.fullPath, spec);
          if (!walkResult.valid) {
            const failedAt = walkResult.resolvedPath.join(".");
            const triedField = ref.fullPath[walkResult.resolvedPath.length];
            const available = walkResult.availableAt?.join(", ") ?? "none";
            issues.push({
              nodeId: node.id,
              service, method, path,
              field: ref.fullPath.join("."),
              severity: "error",
              reason: `Output path "${ref.fullPath.join(".")}" referenced by "${ref.downstreamNodeId}" is invalid: "${triedField}" does not exist under "${failedAt}" in ${service} ${method} ${path} response (available: ${available})`,
            });
          }
        }
      }
    }
  }

  return issues;
}
