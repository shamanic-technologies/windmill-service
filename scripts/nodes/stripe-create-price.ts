// Windmill node script — calls stripe POST /prices/create
export async function main(
  orgId: string,
  productId: string,
  unitAmountInCents: number,
  currency?: string,
  recurring?: { interval: "day" | "week" | "month" | "year"; intervalCount?: number },
  metadata?: Record<string, string>,
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/prices/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ orgId, productId, unitAmountInCents, currency, recurring, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createPrice failed (${response.status}): ${err}`);
  }

  return response.json();
}
