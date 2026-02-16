// Windmill node script — calls stripe POST /prices/create
export async function main(
  productId: string,
  unitAmountInCents: number,
  currency?: string,
  recurring?: { interval: "day" | "week" | "month" | "year"; intervalCount?: number },
  metadata?: Record<string, string>,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
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
      body: JSON.stringify({ productId, unitAmountInCents, currency, recurring, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createPrice failed (${response.status}): ${err}`);
  }

  return response.json();
}
