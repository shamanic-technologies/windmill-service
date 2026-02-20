/**
 * Collects all service URL and API key env vars from the workflow-service process.
 *
 * These are injected into flow_input as `serviceEnvs` so Windmill scripts can
 * read them directly instead of relying on WHITELIST_ENVS (which is unreliable).
 *
 * Matches: *_SERVICE_URL, *_SERVICE_API_KEY, plus non-standard legacy patterns
 * like CONTENT_GENERATION_URL, OUTBOUND_SENDING_URL, REPLY_QUALIFICATION_URL.
 */

const EXCLUDE = new Set([
  "WINDMILL_SERVER_URL",
  "WINDMILL_SERVER_API_KEY",
  "WORKFLOW_SERVICE_DATABASE_URL",
]);

export function collectServiceEnvs(): Record<string, string> {
  const envs: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (EXCLUDE.has(key)) continue;
    if (key.startsWith("RAILWAY_")) continue;
    if (key.endsWith("_SERVICE_URL") || key.endsWith("_SERVICE_API_KEY")) {
      envs[key] = value;
      continue;
    }
    // Non-standard legacy patterns (no _SERVICE_ infix)
    if (
      (key.endsWith("_URL") || key.endsWith("_API_KEY")) &&
      !key.startsWith("WINDMILL_") &&
      !key.includes("DATABASE")
    ) {
      envs[key] = value;
    }
  }

  return envs;
}
