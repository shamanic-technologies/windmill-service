// Windmill node script — calls stripe POST /stats
export async function main(
  runIds?: string[],
  clerkOrgId?: string,
  brandId?: string,
  appId?: string,
  campaignId?: string,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
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
      body: JSON.stringify({ runIds, clerkOrgId, brandId, appId, campaignId }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
