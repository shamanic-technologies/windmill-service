import type { HttpEndpoint } from "./extract-http-endpoints.js";

export interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

export interface ProviderRequirementsResponse {
  requirements: unknown[];
  providers: string[];
}

export interface KeyDecryptResponse {
  key: string;
  keySource: "platform" | "org";
}

function getKeyServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "KEY_SERVICE_URL and KEY_SERVICE_API_KEY must be set to fetch provider requirements"
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

export async function fetchProviderRequirements(
  endpoints: HttpEndpoint[],
  identity: IdentityHeaders,
): Promise<ProviderRequirementsResponse> {
  const { baseUrl, apiKey } = getKeyServiceConfig();

  const url = `${baseUrl}/provider-requirements`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
    body: JSON.stringify({ endpoints }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `key-service error: POST /provider-requirements -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  return res.json() as Promise<ProviderRequirementsResponse>;
}

export async function fetchAnthropicKey(
  opts: { orgId: string; userId: string; runId: string },
): Promise<KeyDecryptResponse> {
  const { baseUrl, apiKey } = getKeyServiceConfig();

  const callerHeaders = {
    "x-caller-service": "workflow",
    "x-caller-method": "POST",
    "x-caller-path": "/workflows/generate",
  };

  const params = new URLSearchParams({
    orgId: opts.orgId,
    userId: opts.userId,
  });
  const path = `/keys/anthropic/decrypt?${params}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-org-id": opts.orgId,
      "x-user-id": opts.userId,
      "x-run-id": opts.runId,
      ...callerHeaders,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `key-service error: GET /keys/anthropic/decrypt -> ${res.status} ${res.statusText}: ${text}`
    );
  }

  const body = (await res.json()) as KeyDecryptResponse;
  return body;
}
