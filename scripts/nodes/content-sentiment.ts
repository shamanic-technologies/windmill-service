// Windmill node script — calls reply-qualification POST /qualify
export async function main(
  emailContent: string,
  context: {
    orgId: string;
  },
  serviceEnvs?: Record<string, string>,
  orgId?: string,
  userId?: string,
  runId?: string,
) {
  const baseUrl = serviceEnvs?.["REPLY_QUALIFICATION_URL"] ?? Bun.env.REPLY_QUALIFICATION_URL;
  const apiKey = serviceEnvs?.["REPLY_QUALIFICATION_API_KEY"] ?? Bun.env.REPLY_QUALIFICATION_API_KEY;
  if (!baseUrl) throw new Error("REPLY_QUALIFICATION_URL is not set");
  if (!apiKey) throw new Error("REPLY_QUALIFICATION_API_KEY is not set");

  const resolvedOrgId = orgId ?? context?.orgId;
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (resolvedOrgId) reqHeaders["x-org-id"] = resolvedOrgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;

  const response = await fetch(
    `${baseUrl}/qualify`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ content: emailContent }),
    }
  );

  const data = await response.json();
  return { sentiment: data.sentiment, category: data.category };
}
