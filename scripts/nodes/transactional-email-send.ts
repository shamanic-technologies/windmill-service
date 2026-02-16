// Windmill node script — calls transactional-email POST /send
export async function main(
  appId: string,
  eventType: string,
  recipientEmail?: string,
  brandId?: string,
  campaignId?: string,
  productId?: string,
  clerkUserId?: string,
  clerkOrgId?: string,
  metadata?: Record<string, unknown>,
) {
  const baseUrl = Bun.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = Bun.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_URL is not set");
  if (!apiKey) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ appId, eventType, recipientEmail, brandId, campaignId, productId, clerkUserId, clerkOrgId, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email send failed (${response.status}): ${err}`);
  }

  return response.json();
}
