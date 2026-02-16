// Windmill node script — resolves a coupon/discount by fetching live from Stripe
export async function main(
  couponId: string,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/coupons/${couponId}`,
    {
      headers: {
        "X-API-Key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`app.resolveDiscount: failed to fetch coupon "${couponId}" (${response.status}): ${err}`);
  }

  const data = await response.json() as {
    couponId: string;
    name: string | null;
    percentOff: number | null;
    amountOffInCents: number | null;
    currency: string | null;
    duration: string;
    valid: boolean;
  };

  return {
    stripeCouponId: data.couponId,
    name: data.name,
    percentOff: data.percentOff,
    amountOffInCents: data.amountOffInCents,
    currency: data.currency,
    duration: data.duration,
    valid: data.valid,
  };
}
