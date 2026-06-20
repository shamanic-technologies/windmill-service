// Windmill node script — resolves a product by fetching live from Stripe
export async function main(
  productId: string,
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
  audienceId?: string,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const reqHeaders: Record<string, string> = {};
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (audienceId) reqHeaders["x-audience-id"] = audienceId;
  if (apiKey) reqHeaders["x-api-key"] = apiKey;

  const response = await fetch(
    `${baseUrl}/products/${productId}`,
    {
      headers: reqHeaders,
      signal: AbortSignal.timeout(600_000),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`app.resolveProduct: failed to fetch product "${productId}" (${response.status}): ${err}`);
  }

  const data = await response.json() as { productId: string; name: string; description?: string };

  return {
    stripeProductId: data.productId,
    name: data.name,
    description: data.description,
  };
}
