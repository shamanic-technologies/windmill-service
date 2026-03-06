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

function buildHeaders(apiKey: string, identity?: IdentityHeaders): Record<string, string> {
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (identity) {
    headers["x-org-id"] = identity.orgId;
    headers["x-user-id"] = identity.userId;
    headers["x-run-id"] = identity.runId;
  }
  return headers;
}

/** GET /llm-context — compact summary of all services and endpoints for LLM consumption */
export async function fetchLlmContext(identity?: IdentityHeaders): Promise<LlmContextResponse> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(`${baseUrl}/llm-context`, {
    method: "GET",
    headers: buildHeaders(apiKey, identity),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /llm-context -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<LlmContextResponse>;
}

/** GET /services — list all registered services (used for health check + enumeration) */
export async function fetchServiceList(
  identity?: IdentityHeaders,
): Promise<Array<{ service: string }>> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(`${baseUrl}/services`, {
    method: "GET",
    headers: buildHeaders(apiKey, identity),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `api-registry error: GET /services -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<Array<{ service: string }>>;
}

/** Fetch OpenAPI specs for multiple services (deduplicated). Returns Map<serviceName, spec> */
export async function fetchSpecsForServices(
  serviceNames: string[],
  identity?: IdentityHeaders,
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(serviceNames)];
  const specs = new Map<string, Record<string, unknown>>();

  const results = await Promise.allSettled(
    unique.map(async (name) => {
      const spec = await fetchServiceSpec(name, identity);
      return { name, spec };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      specs.set(result.value.name, result.value.spec);
    } else {
      console.warn(`[api-registry] Failed to fetch spec: ${result.reason}`);
    }
  }

  return specs;
}

/** GET /openapi/:service — full OpenAPI spec for one service */
export async function fetchServiceSpec(
  serviceName: string,
  identity?: IdentityHeaders,
): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey } = getApiRegistryConfig();

  const res = await fetch(
    `${baseUrl}/openapi/${encodeURIComponent(serviceName)}`,
    {
      method: "GET",
      headers: buildHeaders(apiKey, identity),
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
