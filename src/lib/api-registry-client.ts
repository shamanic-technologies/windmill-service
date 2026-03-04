import type { IdentityHeaders } from "./key-service-client.js";

export interface LlmServiceSummary {
  service: string;
  baseUrl: string;
  title?: string;
  description?: string;
  error?: string;
  endpoints: Array<{
    method: string;
    path: string;
    summary: string;
    params?: Array<{ name: string; in: string; required: boolean; type?: string }>;
    bodyFields?: string[];
  }>;
}

export interface LlmContextResponse {
  _description: string;
  _usage: string;
  services: LlmServiceSummary[];
}

function getApiRegistryConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.API_REGISTRY_SERVICE_URL;
  const apiKey = process.env.API_REGISTRY_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "API_REGISTRY_SERVICE_URL and API_REGISTRY_SERVICE_API_KEY must be set"
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/** GET /llm-context — compact summary of all services and endpoints for LLM consumption */
export async function fetchLlmContext(identity: IdentityHeaders): Promise<LlmContextResponse> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(`${baseUrl}/llm-context`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /llm-context -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<LlmContextResponse>;
}

/** GET /openapi/:service — full OpenAPI spec for one service */
export async function fetchServiceSpec(
  serviceName: string,
  identity: IdentityHeaders,
): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(
    `${baseUrl}/openapi/${encodeURIComponent(serviceName)}`,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-run-id": identity.runId,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /openapi/${serviceName} -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<Record<string, unknown>>;
}
