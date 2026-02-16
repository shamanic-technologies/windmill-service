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
  }
) {
  const baseUrl = Bun.env.LEAD_SERVICE_URL;
  const apiKey = Bun.env.LEAD_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("LEAD_SERVICE_URL is not set");
  if (!apiKey) throw new Error("LEAD_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/buffer/next`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-clerk-org-id": context.orgId,
      },
      body: JSON.stringify({
        campaignId: context.campaignId,
        brandId: context.brandId,
        parentRunId: context.runId,
        searchParams,
      }),
    }
  );

  const data = await response.json();
  if (!data.found) throw new Error("No lead found in buffer");
  return { lead: data.lead };
}
