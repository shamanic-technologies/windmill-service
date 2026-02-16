// Windmill node script — calls brand-service
export async function main(
  action: string,
  context: {
    orgId: string;
    brandId: string;
  }
) {
  const baseUrl = Bun.env.BRAND_SERVICE_URL;
  const apiKey = Bun.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("BRAND_SERVICE_URL is not set");
  if (!apiKey) throw new Error("BRAND_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/brands/${context.brandId}`,
    {
      headers: {
        "x-api-key": apiKey,
        "x-clerk-org-id": context.orgId,
      },
    }
  );

  const data = await response.json();
  return { brand: data };
}
