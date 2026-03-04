import type { IdentityHeaders } from "./key-service-client.js";

// --- Config helpers (same pattern as key-service-client.ts) ---

function getRunsServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to fetch run costs"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

function getEmailGatewayConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "EMAIL_GATEWAY_SERVICE_URL and EMAIL_GATEWAY_SERVICE_API_KEY must be set to fetch email stats"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

// --- Types ---

export interface RunCost {
  runId: string;
  totalCostInUsdCents: number;
}

export interface EmailStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  recipients: number;
}

export interface EmailStatsResponse {
  transactional: EmailStats;
  broadcast: EmailStats;
}

// --- Fetch run costs from runs-service ---

export async function fetchRunCosts(runIds: string[], identity: IdentityHeaders): Promise<RunCost[]> {
  if (runIds.length === 0) return [];

  const { baseUrl, apiKey } = getRunsServiceConfig();
  const costs: RunCost[] = [];

  await Promise.all(
    runIds.map(async (runId) => {
      const res = await fetch(`${baseUrl}/v1/runs/${runId}`, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "x-org-id": identity.orgId,
          "x-user-id": identity.userId,
          "x-run-id": identity.runId,
        },
      });
      if (!res.ok) {
        console.warn(
          `[stats-client] Failed to fetch run ${runId}: ${res.status}`
        );
        return;
      }
      const body = (await res.json()) as {
        id: string;
        totalCostInUsdCents: string;
      };
      costs.push({
        runId: body.id,
        totalCostInUsdCents: Number(body.totalCostInUsdCents) || 0,
      });
    })
  );

  return costs;
}

// --- Fetch email stats from email-gateway-service ---

const EMPTY_STATS: EmailStats = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  recipients: 0,
};

export async function fetchEmailStats(
  runIds: string[],
  identity: IdentityHeaders,
): Promise<EmailStatsResponse> {
  if (runIds.length === 0) {
    return { transactional: { ...EMPTY_STATS }, broadcast: { ...EMPTY_STATS } };
  }

  const { baseUrl, apiKey } = getEmailGatewayConfig();

  const res = await fetch(`${baseUrl}/stats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
    body: JSON.stringify({ runIds }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `email-gateway-service error: POST /stats -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<EmailStatsResponse>;
}
