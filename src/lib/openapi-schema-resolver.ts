export interface ResolvedSchema {
  properties: Record<string, unknown>;
  required: string[];
  /**
   * Schema for values keyed by dynamic (caller-chosen) keys. Set when the source
   * schema declares `additionalProperties`. Used by walkSchemaPath to descend
   * into maps whose keys are not statically known (e.g. brand-service
   * extract-fields returns `fields: { <caller-chosen-key>: MultiBrandFieldValue }`).
   *
   * Values:
   *   - `Record<string, unknown>` — value schema; dynamic keys must match it
   *   - `true` — open map; any value shape allowed
   *   - undefined — no fallback (strict properties-only object)
   */
  additionalProperties?: Record<string, unknown> | true;
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

  // Direct schema with properties and/or additionalProperties
  const hasProperties =
    typeof schema.properties === "object" && schema.properties !== null;
  const additional = normalizeAdditionalProperties(schema.additionalProperties);

  if (hasProperties || additional !== undefined) {
    const resolved: ResolvedSchema = {
      properties: hasProperties
        ? (schema.properties as Record<string, unknown>)
        : {},
      required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
    };
    if (additional !== undefined) {
      resolved.additionalProperties = additional;
    }
    return resolved;
  }

  return null;
}

function normalizeAdditionalProperties(
  raw: unknown,
): Record<string, unknown> | true | undefined {
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined) return undefined;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return undefined;
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
export interface WalkResult {
  valid: boolean;
  /** The path segments that were successfully resolved */
  resolvedPath: string[];
  /** Available properties at the point of failure (empty if valid) */
  availableAt?: string[];
}

/**
 * Walks a nested path through a JSON Schema, resolving $refs along the way.
 * Returns whether the full path resolves to an existing field.
 */
export function walkSchemaPath(
  schema: ResolvedSchema,
  path: string[],
  spec: Record<string, unknown>,
): WalkResult {
  let current: ResolvedSchema | null = schema;
  // Track the raw schema alongside the resolved one so we can detect arrays
  let currentRaw: Record<string, unknown> | null = null;
  const resolvedPath: string[] = [];

  for (const segment of path) {
    if (!current) {
      // current is null — previous property was a primitive or unresolvable.
      // But if we have a raw schema that is an array and the segment is numeric,
      // we can traverse into items.
      if (currentRaw && /^\d+$/.test(segment)) {
        const arrayItems = resolveArrayItems(currentRaw, spec);
        if (arrayItems) {
          resolvedPath.push(segment);
          if (resolvedPath.length === path.length) {
            return { valid: true, resolvedPath };
          }
          current = arrayItems.resolved;
          currentRaw = arrayItems.raw;
          continue;
        }
      }
      return { valid: false, resolvedPath, availableAt: [] };
    }

    const prop = current.properties[segment];
    if (!prop) {
      // Fallback: dynamic-key maps declared via `additionalProperties`.
      // Brand-service extract-fields returns `fields: { <caller-key>: MultiBrandFieldValue }`,
      // so a path like fields.founders.value must descend into the value schema
      // without rejecting "founders" as unknown.
      if (current.additionalProperties !== undefined) {
        resolvedPath.push(segment);
        if (resolvedPath.length === path.length) {
          return { valid: true, resolvedPath };
        }
        if (current.additionalProperties === true) {
          // Open map: any remaining segments are accepted
          for (let i = resolvedPath.length; i < path.length; i++) {
            resolvedPath.push(path[i]);
          }
          return { valid: true, resolvedPath };
        }
        const rawAdditional = resolveRawSchema(current.additionalProperties, spec);
        current = resolveSchema(rawAdditional, spec);
        currentRaw = rawAdditional;
        continue;
      }
      return {
        valid: false,
        resolvedPath,
        availableAt: formatAvailableKeys(current.properties, spec),
      };
    }

    resolvedPath.push(segment);

    // If this is the last segment, we're done — the field exists
    if (resolvedPath.length === path.length) {
      return { valid: true, resolvedPath };
    }

    // Try to descend into the property's schema
    if (typeof prop === "object" && prop !== null) {
      const rawProp = resolveRawSchema(prop as Record<string, unknown>, spec);
      current = resolveSchema(rawProp, spec);
      currentRaw = rawProp;
    } else {
      current = null;
      currentRaw = null;
    }
  }

  return { valid: true, resolvedPath };
}

/**
 * Resolves the RAW schema sitting at a nested path inside a resolved schema,
 * following $refs on the way down. Returns null when the path does not resolve
 * to a declared schema — including dynamic-key maps whose value shape is open
 * (`additionalProperties: true`), because those constrain nothing.
 *
 * Used by value-level validation: a leaf schema is the only place a closed set
 * of permitted values (`enum` / `const`) can be declared.
 */
export function getSchemaAtPath(
  schema: ResolvedSchema,
  path: string[],
  spec: Record<string, unknown>,
): Record<string, unknown> | null {
  let current: ResolvedSchema | null = schema;

  for (let i = 0; i < path.length; i++) {
    if (!current) return null;

    let prop = current.properties[path[i]];
    if (prop === undefined) {
      // Dynamic-key map: the value schema applies to every caller-chosen key.
      const additional = current.additionalProperties;
      if (additional === undefined || additional === true) return null;
      prop = additional;
    }

    if (typeof prop !== "object" || prop === null) return null;

    const raw = resolveRawSchema(prop as Record<string, unknown>, spec);
    if (i === path.length - 1) return raw;
    current = resolveSchema(raw, spec);
  }

  return null;
}

/**
 * Formats the keys available at a path-failure point. For object-typed values,
 * inlines up to 5 sub-keys as `key{sub1,sub2,...}` so callers see one level
 * deeper without a second round-trip. Scalars stay bare.
 *
 * Example: `lead.data.organizationName` fails at `lead.data` →
 *   ["leadId", "firstName", "organization{name,industry,estimatedNumEmployees,...}"]
 */
function formatAvailableKeys(
  properties: Record<string, unknown>,
  spec: Record<string, unknown>,
): string[] {
  const MAX_SUB_KEYS = 5;
  return Object.entries(properties).map(([key, value]) => {
    if (typeof value !== "object" || value === null) return key;
    const raw = resolveRawSchema(value as Record<string, unknown>, spec);
    const resolved = resolveSchema(raw, spec);
    if (!resolved || Object.keys(resolved.properties).length === 0) return key;
    const subKeys = Object.keys(resolved.properties);
    const shown = subKeys.slice(0, MAX_SUB_KEYS).join(",");
    const suffix = subKeys.length > MAX_SUB_KEYS ? ",..." : "";
    return `${key}{${shown}${suffix}}`;
  });
}

/**
 * Resolves $ref in a raw schema without requiring properties (unlike resolveSchema).
 */
function resolveRawSchema(
  schema: Record<string, unknown>,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof schema.$ref === "string") {
    const resolved = followRef(schema.$ref, spec);
    return resolved ?? schema;
  }
  return schema;
}

/**
 * If the schema is an array type, resolves its items schema.
 */
function resolveArrayItems(
  rawSchema: Record<string, unknown>,
  spec: Record<string, unknown>,
): { resolved: ResolvedSchema | null; raw: Record<string, unknown> } | null {
  if (rawSchema.type !== "array" || !rawSchema.items) return null;
  const itemsRaw = resolveRawSchema(rawSchema.items as Record<string, unknown>, spec);
  return { resolved: resolveSchema(itemsRaw, spec), raw: itemsRaw };
}

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
