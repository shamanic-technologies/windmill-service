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

  return transforms;
}
