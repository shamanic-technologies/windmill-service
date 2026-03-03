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
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/checkout/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        lineItems, successUrl, cancelUrl, mode, customerId, customerEmail,
        metadata, discounts, orgId, brandId, campaignId, runId,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCheckout failed (${response.status}): ${err}`);
  }

  return response.json();
}
