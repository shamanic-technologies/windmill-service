// Windmill node script — calls stripe POST /coupons/create
export async function main(
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
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/coupons/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ id, name, percentOff, amountOffInCents, currency, duration, durationInMonths, maxRedemptions, redeemBy, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCoupon failed (${response.status}): ${err}`);
  }

  return response.json();
}
