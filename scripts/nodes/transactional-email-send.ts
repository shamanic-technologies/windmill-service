// Windmill node script — calls transactional-email POST /send
export async function main(
  eventType: string,
  recipientEmail?: string,
  brandId?: string,
  campaignId?: string,
  productId?: string,
  userId?: string,
  orgId?: string,
  metadata?: Record<string, unknown>,
  serviceEnvs?: Record<string, string>,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.["TRANSACTIONAL_EMAIL_SERVICE_URL"] ?? Bun.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = serviceEnvs?.["TRANSACTIONAL_EMAIL_SERVICE_API_KEY"] ?? Bun.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_URL is not set");
  if (!apiKey) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_API_KEY is not set");

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (audienceId) reqHeaders["x-audience-id"] = audienceId;

  const response = await fetch(
    `${baseUrl}/send`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ eventType, recipientEmail, brandId, campaignId, productId, userId, orgId, metadata }),
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email send failed (${response.status}): ${err}`);
  }

  return response.json();
}
