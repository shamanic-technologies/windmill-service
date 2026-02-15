// Windmill node script — calls stripe POST /checkout/create
export async function main(
  config: {
    lineItems: { priceId: string; quantity: number }[];
    successUrl: string;
    cancelUrl: string;
    mode?: "payment" | "subscription";
    customerId?: string;
    customerEmail?: string;
    metadata?: Record<string, string>;
    discounts?: { coupon?: string; promotionCode?: string }[];
  },
  context?: {
    orgId?: string;
    brandId?: string;
    campaignId?: string;
    runId?: string;
    appId?: string;
  }
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
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
        ...config,
        orgId: context?.orgId,
        brandId: context?.brandId,
        campaignId: context?.campaignId,
        runId: context?.runId,
        appId: context?.appId,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCheckout failed (${response.status}): ${err}`);
  }

  return response.json();
}
