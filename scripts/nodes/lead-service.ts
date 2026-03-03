// Windmill node script — calls lead-service POST /buffer/next
export async function main(
  source: string | undefined,
  searchParams: Record<string, unknown> | undefined,
  context: {
    orgId: string;
    brandId: string;
    campaignId: string;
    subrequestId?: string;
    runId: string;
  },
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
) {
  const baseUrl = serviceEnvs?.LEAD_SERVICE_URL ?? Bun.env.LEAD_SERVICE_URL;
  const apiKey = serviceEnvs?.LEAD_SERVICE_API_KEY ?? Bun.env.LEAD_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("LEAD_SERVICE_URL is not set");
  if (!apiKey) throw new Error("LEAD_SERVICE_API_KEY is not set");

  const resolvedOrgId = orgId ?? context?.orgId;
  const resolvedRunId = runId ?? context?.runId;
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (resolvedOrgId) reqHeaders["x-org-id"] = resolvedOrgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (resolvedRunId) reqHeaders["x-run-id"] = resolvedRunId;

  const response = await fetch(
    `${baseUrl}/buffer/next`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({
        campaignId: context.campaignId,
        brandId: context.brandId,
        parentRunId: resolvedRunId,
        searchParams,
      }),
    }
  );

  const data = await response.json();
  if (!data.found) throw new Error("No lead found in buffer");
  return { lead: data.lead };
}
