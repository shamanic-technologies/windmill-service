/**
 * Fire-and-forget structured event logger.
 * Posts events to runs-service for tracing workflow execution steps.
 */

const FORWARDED_HEADERS = [
  "x-org-id",
  "x-user-id",
  "x-brand-id",
  "x-campaign-id",
  "x-workflow-slug",
  "x-feature-slug",
  "x-goal",
  "x-brand-profile-id",
  "x-profile-id",
  "x-persona-id",
  "x-goal-id",
  "x-goal-slug",
  "x-optimization-goal",
] as const;

export async function traceEvent(
  runId: string,
  payload: {
    service: string;
    event: string;
    detail?: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
  },
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error("[workflow-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace event");
    return;
  }

  const baseUrl = url.replace(/\/$/, "");
  const outHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };

  for (const key of FORWARDED_HEADERS) {
    const value = headers[key];
    if (typeof value === "string") {
      outHeaders[key] = value;
    }
  }

  try {
    await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      method: "POST",
      headers: outHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    console.error("[workflow-service] Failed to trace event:", err);
  }
}
