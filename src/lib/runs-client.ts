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
 * @param opts.taskName - Name of the task being executed
 * @param opts.workflowName - Optional workflow name for tracking
 * @returns The newly created run's ID
 */
export async function createRun(opts: {
  parentRunId: string;
  orgId: string;
  userId: string;
  taskName: string;
  workflowName?: string;
}): Promise<CreateRunResult> {
  const { baseUrl, apiKey } = getRunsServiceConfig();

  const body: Record<string, string> = {
    serviceName: "workflow",
    taskName: opts.taskName,
  };
  if (opts.workflowName) {
    body.workflowName = opts.workflowName;
  }

  const res = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": opts.orgId,
      "x-user-id": opts.userId,
      "x-run-id": opts.parentRunId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: POST /v1/runs -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as { id: string };
  return { runId: data.id };
}

/** POST /v1/platform-runs — create a platform-level run (no org/user context) */
export async function createPlatformRun(opts: {
  serviceName: string;
  taskName: string;
  workflowName?: string;
}): Promise<CreateRunResult> {
  const { baseUrl, apiKey } = getRunsServiceConfig();

  const body: Record<string, string> = {
    serviceName: opts.serviceName,
    taskName: opts.taskName,
  };
  if (opts.workflowName) {
    body.workflowName = opts.workflowName;
  }

  const res = await fetch(`${baseUrl}/v1/platform-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-service-name": "workflow-service",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: POST /v1/platform-runs -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as { id: string };
  return { runId: data.id };
}

/** PATCH /v1/platform-runs/:id — close a platform-level run */
export async function closePlatformRun(
  runId: string,
  status: "completed" | "failed",
): Promise<void> {
  const { baseUrl, apiKey } = getRunsServiceConfig();

  const res = await fetch(`${baseUrl}/v1/platform-runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-service-name": "workflow-service",
    },
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `runs-service error: PATCH /v1/platform-runs/${runId} -> ${res.status} ${res.statusText}: ${text}`
    );
  }
}
