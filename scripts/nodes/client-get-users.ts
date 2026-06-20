// Windmill node script — calls client GET /anonymous-users?orgId=...
export async function main(
  orgId: string,
  limit?: number,
  offset?: number,
  serviceEnvs?: Record<string, string>,
  userId?: string,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.CLIENT_SERVICE_URL ?? Bun.env.CLIENT_SERVICE_URL;
  const apiKey = serviceEnvs?.CLIENT_SERVICE_API_KEY ?? Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");

  const params = new URLSearchParams({ orgId });
  if (limit) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));

  const reqHeaders: Record<string, string> = {};
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (audienceId) reqHeaders["x-audience-id"] = audienceId;
  if (apiKey) reqHeaders["x-api-key"] = apiKey;

  const response = await fetch(
    `${baseUrl}/anonymous-users?${params}`,
    {
      headers: reqHeaders,
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client getUsers failed (${response.status}): ${err}`);
  }

  return response.json();
}
