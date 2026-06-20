// Windmill node script — calls client-service for contact/user management
export async function main(
  action: "create" | "get" | "list" | "update",
  appId?: string,
  contactData?: Record<string, unknown>,
  context?: {
    orgId?: string;
  },
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.CLIENT_SERVICE_URL ?? Bun.env.CLIENT_SERVICE_URL;
  const apiKey = serviceEnvs?.CLIENT_SERVICE_API_KEY ?? Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");
  const resolvedOrgId = orgId ?? context?.orgId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (resolvedOrgId) headers["x-org-id"] = resolvedOrgId;
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  if (audienceId) headers["x-audience-id"] = audienceId;

  if (action === "create" || action === "update") {
    const response = await fetch(`${baseUrl}/anonymous-users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        appId,
        ...contactData,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    return response.json();
  }

  if (action === "list") {
    const response = await fetch(
      `${baseUrl}/anonymous-users?appId=${appId}`,
      { headers, signal: AbortSignal.timeout(600_000) }
    );
    return response.json();
  }

  if (action === "get" && contactData?.id) {
    const response = await fetch(
      `${baseUrl}/anonymous-users/${contactData.id}`,
      { headers, signal: AbortSignal.timeout(600_000) }
    );
    return response.json();
  }

  throw new Error(`Unknown client-service action: ${action}`);
}
