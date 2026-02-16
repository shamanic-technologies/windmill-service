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
  }
) {
  const baseUrl = Bun.env.CONTENT_GENERATION_URL;
  const apiKey = Bun.env.CONTENT_GENERATION_API_KEY;
  if (!baseUrl) throw new Error("CONTENT_GENERATION_URL is not set");
  if (!apiKey) throw new Error("CONTENT_GENERATION_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-clerk-org-id": context.orgId,
      },
      body: JSON.stringify({
        contentType,
        leadData,
        clientData,
        runId: context.runId,
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
