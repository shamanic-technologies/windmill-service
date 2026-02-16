// Windmill node script — calls stripe GET /products/:productId
export async function main(
  productId: string,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/products/${productId}`,
    {
      headers: {
        "X-API-Key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
