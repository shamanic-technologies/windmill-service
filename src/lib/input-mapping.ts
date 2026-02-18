export interface InputTransform {
  type: "static" | "javascript";
  value?: unknown;
  expr?: string;
}

/**
 * Translates our inputMapping format to Windmill input_transforms.
 *
 * "$ref:node-id.output.field" → { type: "javascript", expr: "results.node_id.field" }
 * "$ref:flow_input.field"     → { type: "javascript", expr: "flow_input.field" }
 * static value                → { type: "static", value }
 *
 * Dot-notation keys (e.g. "body.campaignId") are collapsed into nested
 * JavaScript object expressions so Windmill passes them as a single parameter.
 */
export function buildInputTransforms(
  config?: Record<string, unknown>,
  inputMapping?: Record<string, string>
): Record<string, InputTransform> {
  const transforms: Record<string, InputTransform> = {};

  if (config) {
    for (const [key, value] of Object.entries(config)) {
      transforms[key] = { type: "static", value };
    }
  }

  if (inputMapping) {
    for (const [key, ref] of Object.entries(inputMapping)) {
      if (typeof ref === "string" && ref.startsWith("$ref:")) {
        const path = ref.replace("$ref:", "");
        let expr: string;

        if (path === "flow_input" || path.startsWith("flow_input.")) {
          expr = path;
        } else {
          // "node-id.output.field" → "results.node_id.field"
          // "node-id.output" → "results.node_id" (whole output)
          const parts = path.split(".");
          const nodeId = parts[0].replace(/-/g, "_");
          // Skip "output" part if present
          const rest = parts.slice(1).filter((p) => p !== "output");
          expr = rest.length > 0
            ? `results.${nodeId}.${rest.join(".")}`
            : `results.${nodeId}`;
        }

        transforms[key] = { type: "javascript", expr };
      } else {
        transforms[key] = { type: "static", value: ref };
      }
    }
  }

  return collapseDotNotation(transforms);
}

function toExpr(t: InputTransform): string {
  return t.type === "javascript" ? t.expr! : JSON.stringify(t.value);
}

function safeKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Collapses dot-notation keys into nested JavaScript object expressions.
 *
 * Windmill input_transforms keys map directly to function parameters — a key
 * like "body.campaignId" does NOT set body.campaignId on the script; it tries
 * to pass a parameter literally named "body.campaignId" which doesn't match.
 *
 * This function detects dot-notation keys, groups them by root, and builds a
 * single JavaScript expression that constructs the nested object. If a static
 * base value exists for the root key (e.g. config.body = { tag: "cold-email" }),
 * it's spread into the expression first.
 */
export function collapseDotNotation(
  transforms: Record<string, InputTransform>
): Record<string, InputTransform> {
  const dotKeys = Object.keys(transforms).filter((k) => k.includes("."));
  if (dotKeys.length === 0) return transforms;

  const result: Record<string, InputTransform> = {};
  const dotGroups = new Map<string, Array<{ path: string; transform: InputTransform }>>();

  for (const [key, transform] of Object.entries(transforms)) {
    const dotIdx = key.indexOf(".");
    if (dotIdx === -1) {
      result[key] = transform;
    } else {
      const root = key.slice(0, dotIdx);
      const path = key.slice(dotIdx + 1);
      if (!dotGroups.has(root)) dotGroups.set(root, []);
      dotGroups.get(root)!.push({ path, transform });
    }
  }

  for (const [root, children] of dotGroups) {
    // If there's a static base for this root key, we spread it first
    const staticBase = result[root]?.type === "static" ? result[root].value : undefined;
    const baseObj = (staticBase && typeof staticBase === "object" && staticBase !== null)
      ? staticBase as Record<string, unknown>
      : undefined;

    // Separate direct fields (body.field) from nested fields (body.metadata.field)
    const directFields = new Map<string, string>();
    const nestedGroups = new Map<string, Array<{ subPath: string; expr: string }>>();

    for (const { path, transform } of children) {
      const subDot = path.indexOf(".");
      if (subDot === -1) {
        directFields.set(path, toExpr(transform));
      } else {
        const parent = path.slice(0, subDot);
        const child = path.slice(subDot + 1);
        if (!nestedGroups.has(parent)) nestedGroups.set(parent, []);
        nestedGroups.get(parent)!.push({ subPath: child, expr: toExpr(transform) });
      }
    }

    const parts: string[] = [];

    // Spread static base
    if (baseObj) {
      parts.push(`...${JSON.stringify(baseObj)}`);
    }

    // Direct field overrides: body.campaignId → campaignId: expr
    for (const [field, expr] of directFields) {
      parts.push(`${safeKey(field)}: ${expr}`);
    }

    // Nested field merges: body.metadata.emailGenerationId → metadata: { ...static, field: expr }
    for (const [parent, subs] of nestedGroups) {
      const parentStatic = baseObj?.[parent];
      const nestedParts: string[] = [];
      if (parentStatic && typeof parentStatic === "object" && parentStatic !== null) {
        nestedParts.push(`...${JSON.stringify(parentStatic)}`);
      }
      for (const { subPath, expr } of subs) {
        nestedParts.push(`${safeKey(subPath)}: ${expr}`);
      }
      parts.push(`${safeKey(parent)}: {${nestedParts.join(", ")}}`);
    }

    result[root] = { type: "javascript", expr: `({${parts.join(", ")}})` };
  }

  return result;
}
