export interface ResolvedSchema {
  properties: Record<string, unknown>;
  required: string[];
}

/**
 * Resolves a JSON Schema that may contain $ref pointers within an OpenAPI spec.
 * Handles $ref, allOf, oneOf, anyOf by merging all variants' properties.
 * Returns null if the schema has no properties (primitive, array, etc.).
 */
export function resolveSchema(
  schema: Record<string, unknown>,
  spec: Record<string, unknown>,
  depth = 0,
): ResolvedSchema | null {
  if (depth > 10) return null;

  // Follow $ref
  if (typeof schema.$ref === "string") {
    const resolved = followRef(schema.$ref, spec);
    if (!resolved) return null;
    return resolveSchema(resolved, spec, depth + 1);
  }

  // Handle allOf — merge all sub-schemas
  if (Array.isArray(schema.allOf)) {
    const merged: ResolvedSchema = { properties: {}, required: [] };
    for (const sub of schema.allOf) {
      if (typeof sub !== "object" || sub === null) continue;
      const resolved = resolveSchema(sub as Record<string, unknown>, spec, depth + 1);
      if (resolved) {
        Object.assign(merged.properties, resolved.properties);
        merged.required.push(...resolved.required);
      }
    }
    return Object.keys(merged.properties).length > 0 ? merged : null;
  }

  // Handle oneOf/anyOf — merge all variants to get the union of known fields
  for (const combiner of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[combiner])) {
      const merged: ResolvedSchema = { properties: {}, required: [] };
      for (const sub of schema[combiner] as unknown[]) {
        if (typeof sub !== "object" || sub === null) continue;
        const resolved = resolveSchema(sub as Record<string, unknown>, spec, depth + 1);
        if (resolved) {
          Object.assign(merged.properties, resolved.properties);
          // Only keep required fields that appear in ALL variants
        }
      }
      // Also merge direct properties if present
      if (typeof schema.properties === "object" && schema.properties !== null) {
        Object.assign(merged.properties, schema.properties);
      }
      return Object.keys(merged.properties).length > 0 ? merged : null;
    }
  }

  // Direct schema with properties
  if (typeof schema.properties === "object" && schema.properties !== null) {
    return {
      properties: schema.properties as Record<string, unknown>,
      required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
    };
  }

  return null;
}

/**
 * Follows a JSON Pointer $ref like "#/components/schemas/Foo" within a spec.
 */
function followRef(
  ref: string,
  spec: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : null;
}

/**
 * Extracts the requestBody schema for an endpoint from an OpenAPI spec.
 */
export function getRequestBodySchema(
  spec: Record<string, unknown>,
  path: string,
  method: string,
): ResolvedSchema | null {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return null;

  const pathEntry = paths[path];
  if (!pathEntry) return null;

  const operation = pathEntry[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!operation) return null;

  const requestBody = operation.requestBody as Record<string, unknown> | undefined;
  if (!requestBody) return null;

  const content = requestBody.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) {
    // Some specs put schema directly on requestBody (simplified format from api-registry)
    if (requestBody.schema && typeof requestBody.schema === "object") {
      return resolveSchema(requestBody.schema as Record<string, unknown>, spec);
    }
    return null;
  }

  const jsonContent = content["application/json"];
  if (!jsonContent?.schema) return null;

  return resolveSchema(jsonContent.schema as Record<string, unknown>, spec);
}

/**
 * Extracts the success response schema for an endpoint from an OpenAPI spec.
 * Tries 200, then 201, then 2xx.
 */
export function getResponseSchema(
  spec: Record<string, unknown>,
  path: string,
  method: string,
): ResolvedSchema | null {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return null;

  const pathEntry = paths[path];
  if (!pathEntry) return null;

  const operation = pathEntry[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!operation) return null;

  const responses = operation.responses as Record<string, Record<string, unknown>> | undefined;
  if (!responses) return null;

  for (const code of ["200", "201", "2xx"]) {
    const response = responses[code];
    if (!response) continue;

    // Check for schema directly on response (simplified format)
    if (response.schema && typeof response.schema === "object") {
      return resolveSchema(response.schema as Record<string, unknown>, spec);
    }

    const content = response.content as Record<string, Record<string, unknown>> | undefined;
    if (!content) continue;

    const jsonContent = content["application/json"];
    if (!jsonContent?.schema) continue;

    return resolveSchema(jsonContent.schema as Record<string, unknown>, spec);
  }

  return null;
}
