// Windmill node script — calls stripe POST /stats
export async function main(
  runIds?: string[],
  orgId?: string,
  brandId?: string,
  campaignId?: string,
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.STRIPE_SERVICE_URL ?? Bun.env.STRIPE_SERVICE_URL;
  const apiKey = serviceEnvs?.STRIPE_SERVICE_API_KEY ?? Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/stats`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ runIds, orgId, brandId, campaignId }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
