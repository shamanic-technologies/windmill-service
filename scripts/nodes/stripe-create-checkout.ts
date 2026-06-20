// Windmill node script — calls stripe POST /checkout/create
export async function main(
  lineItems: { priceId: string; quantity: number }[],
  successUrl: string,
  cancelUrl: string,
  mode?: "payment" | "subscription",
  customerId?: string,
  customerEmail?: string,
  metadata?: Record<string, string>,
  discounts?: { coupon?: string; promotionCode?: string }[],
  orgId?: string,
  brandId?: string,
  campaignId?: string,
  runId?: string,
  audienceId?: string,
  serviceEnvs?: Record<string, string>,
  userId?: string,
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
    `${baseUrl}/checkout/create`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({
        lineItems, successUrl, cancelUrl, mode, customerId, customerEmail,
        metadata, discounts, orgId, brandId, campaignId, runId,
      }),
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCheckout failed (${response.status}): ${err}`);
  }

  return response.json();
}
