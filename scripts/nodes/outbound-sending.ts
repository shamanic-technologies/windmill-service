// Windmill node script — calls email-sending POST /send
export async function main(
  channel: string,
  sendType: string,
  toEmail: string,
  subject: string,
  bodyHtml: string,
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
  const baseUrl = serviceEnvs?.["OUTBOUND_SENDING_URL"] ?? Bun.env.OUTBOUND_SENDING_URL;
  const apiKey = serviceEnvs?.["OUTBOUND_SENDING_API_KEY"] ?? Bun.env.OUTBOUND_SENDING_API_KEY;
  if (!baseUrl) throw new Error("OUTBOUND_SENDING_URL is not set");
  if (!apiKey) throw new Error("OUTBOUND_SENDING_API_KEY is not set");

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
    `${baseUrl}/send`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({
        type: sendType,
        channel,
        toEmail,
        subject,
        bodyHtml,
        runId: resolvedRunId,
        campaignId: context.campaignId,
        brandId: context.brandId,
      }),
    }
  );

  const data = await response.json();
  return { success: data.success, messageId: data.messageId };
}
