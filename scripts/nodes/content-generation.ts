// Windmill node script — calls email-generation POST /generate
export async function main(
  contentType: string,
  leadData: Record<string, unknown>,
  clientData: Record<string, unknown>,
  context: {
    orgId: string;
    brandId: string;
    campaignId: string;
    runId: string;
  },
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
) {
  const baseUrl = serviceEnvs?.["CONTENT_GENERATION_URL"] ?? Bun.env.CONTENT_GENERATION_URL;
  const apiKey = serviceEnvs?.["CONTENT_GENERATION_API_KEY"] ?? Bun.env.CONTENT_GENERATION_API_KEY;
  if (!baseUrl) throw new Error("CONTENT_GENERATION_URL is not set");
  if (!apiKey) throw new Error("CONTENT_GENERATION_API_KEY is not set");

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
    `${baseUrl}/generate`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({
        contentType,
        leadData,
        clientData,
        runId: resolvedRunId,
        campaignId: context.campaignId,
        brandId: context.brandId,
      }),
    }
  );

  const data = await response.json();
  return {
    id: data.id,
    subject: data.subject,
    bodyHtml: data.bodyHtml,
    email: (leadData as { email?: string }).email,
  };
}
