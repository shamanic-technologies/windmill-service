// Windmill node script — resolves a coupon/discount by fetching live from Stripe
export async function main(
  config: {
    couponId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/coupons/${config.couponId}`,
    {
      headers: {
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`app.resolveDiscount: failed to fetch coupon "${config.couponId}" (${response.status}): ${err}`);
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
