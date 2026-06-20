// Windmill node script — calls client PATCH /anonymous-users/:id
export async function main(
  userId: string,
  firstName?: string,
  lastName?: string,
  phone?: string,
  linkedUserId?: string | null,
  orgId?: string | null,
  metadata?: Record<string, unknown> | null,
  serviceEnvs?: Record<string, string>,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.CLIENT_SERVICE_URL ?? Bun.env.CLIENT_SERVICE_URL;
  const apiKey = serviceEnvs?.CLIENT_SERVICE_API_KEY ?? Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (audienceId) reqHeaders["x-audience-id"] = audienceId;
  if (apiKey) reqHeaders["x-api-key"] = apiKey;

  const response = await fetch(
    `${baseUrl}/anonymous-users/${userId}`,
    {
      method: "PATCH",
      headers: reqHeaders,
      body: JSON.stringify({ firstName, lastName, phone, userId: linkedUserId, orgId, metadata }),
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client updateUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
