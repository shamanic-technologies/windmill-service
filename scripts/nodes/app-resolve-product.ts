// Windmill node script — resolves a product by fetching live from Stripe
export async function main(
  config: {
    productId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/products/${config.productId}`,
    {
      headers: {
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
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
