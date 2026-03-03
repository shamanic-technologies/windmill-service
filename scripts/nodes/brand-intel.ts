// Windmill node script — calls brand-service
export async function main(
  action: string,
  context: {
    orgId: string;
    brandId: string;
  },
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
) {
  const baseUrl = serviceEnvs?.BRAND_SERVICE_URL ?? Bun.env.BRAND_SERVICE_URL;
  const apiKey = serviceEnvs?.BRAND_SERVICE_API_KEY ?? Bun.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("BRAND_SERVICE_URL is not set");
  if (!apiKey) throw new Error("BRAND_SERVICE_API_KEY is not set");

  const resolvedOrgId = orgId ?? context?.orgId;
  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
  };
  if (resolvedOrgId) reqHeaders["x-org-id"] = resolvedOrgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;

  const response = await fetch(
    `${baseUrl}/brands/${context.brandId}`,
    { headers: reqHeaders }
  );

  const data = await response.json();
  return { brand: data };
}
