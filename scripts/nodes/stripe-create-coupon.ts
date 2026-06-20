// Windmill node script — calls stripe POST /coupons/create
export async function main(
  orgId: string,
  id?: string,
  name?: string,
  percentOff?: number,
  amountOffInCents?: number,
  currency?: string,
  duration?: "once" | "repeating" | "forever",
  durationInMonths?: number,
  maxRedemptions?: number,
  redeemBy?: string,
  metadata?: Record<string, string>,
  serviceEnvs?: Record<string, string>,
  userId?: string,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (audienceId) reqHeaders["x-audience-id"] = audienceId;
  if (apiKey) reqHeaders["x-api-key"] = apiKey;

  const response = await fetch(
    `${baseUrl}/coupons/create`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ orgId, id, name, percentOff, amountOffInCents, currency, duration, durationInMonths, maxRedemptions, redeemBy, metadata }),
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCoupon failed (${response.status}): ${err}`);
  }

  return response.json();
}
