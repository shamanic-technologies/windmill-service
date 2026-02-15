// Windmill node script — calls transactional-email POST /stats
export async function main(
  config: {
    appId?: string;
    clerkOrgId?: string;
    clerkUserId?: string;
    eventType?: string;
  }
) {
  const baseUrl = Bun.env.LIFECYCLE_EMAILS_URL;
  const apiKey = Bun.env.LIFECYCLE_EMAILS_API_KEY;
  if (!baseUrl) throw new Error("LIFECYCLE_EMAILS_URL is not set");
  if (!apiKey) throw new Error("LIFECYCLE_EMAILS_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/stats`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(config),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
