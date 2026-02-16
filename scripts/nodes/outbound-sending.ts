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
  }
) {
  const baseUrl = Bun.env.OUTBOUND_SENDING_URL;
  const apiKey = Bun.env.OUTBOUND_SENDING_API_KEY;
  if (!baseUrl) throw new Error("OUTBOUND_SENDING_URL is not set");
  if (!apiKey) throw new Error("OUTBOUND_SENDING_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-clerk-org-id": context.orgId,
      },
      body: JSON.stringify({
        type: sendType,
        channel,
        toEmail,
        subject,
        bodyHtml,
        runId: context.runId,
        campaignId: context.campaignId,
        brandId: context.brandId,
      }),
    }
  );

  const data = await response.json();
  return { success: data.success, messageId: data.messageId };
}
