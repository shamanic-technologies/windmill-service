// Windmill node script — calls stripe GET /coupons/:couponId
export async function main(
  orgId: string,
  couponId: string,
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const url = new URL(`${baseUrl}/coupons/${couponId}`);
  url.searchParams.set("orgId", orgId);

  const response = await fetch(
    url.toString(),
    {
      headers: {
        "X-API-Key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getCoupon failed (${response.status}): ${err}`);
  }

  return response.json();
}
