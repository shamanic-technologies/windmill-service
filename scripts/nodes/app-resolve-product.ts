// Windmill node script — resolves a product by fetching live from Stripe
export async function main(
  config: {
    productId: string;
  }
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/products/${config.productId}`,
    {
      headers: {
        "X-API-Key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`app.resolveProduct: failed to fetch product "${config.productId}" (${response.status}): ${err}`);
  }

  const data = await response.json() as { productId: string; name: string; description?: string };

  return {
    stripeProductId: data.productId,
    name: data.name,
    description: data.description,
  };
}
