// Windmill node script — calls stripe POST /products/create
export async function main(
  orgId: string,
  name: string,
  description?: string,
  id?: string,
  metadata?: Record<string, string>,
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/products/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ orgId, name, description, id, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
