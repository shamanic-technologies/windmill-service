// --- Runs-service client ---
// Creates child runs in runs-service to track execution costs.

function getRunsServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to create runs"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

export interface CreateRunResult {
  runId: string;
}

/**
 * Create a child run in runs-service.
 *
 * @param opts.parentRunId - The caller's run ID (from x-run-id header)
 * @param opts.orgId - Organization ID
 * @param opts.userId - User ID
 * @returns The newly created run's ID
 */
export async function createRun(opts: {
  parentRunId: string;
  orgId: string;
  userId: string;
}): Promise<CreateRunResult> {
  const { baseUrl, apiKey } = getRunsServiceConfig();

  const res = await fetch(`${baseUrl}/runs/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": opts.orgId,
      "x-user-id": opts.userId,
      "x-run-id": opts.parentRunId,
    },
    body: JSON.stringify({
      parentRunId: opts.parentRunId,
      service: "workflow",
      orgId: opts.orgId,
      userId: opts.userId,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: POST /runs/start -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as { runId: string };
  return { runId: body.runId };
}
