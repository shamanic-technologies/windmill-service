// Windmill node script — calls transactional-email POST /send
export async function main(
  config: {
    appId: string;
    eventType: string;
    recipientEmail?: string;
    brandId?: string;
    campaignId?: string;
    productId?: string;
    clerkUserId?: string;
    clerkOrgId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const response = await fetch(
    `${Bun.env.LIFECYCLE_EMAILS_URL!}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.LIFECYCLE_EMAILS_API_KEY!,
      },
      body: JSON.stringify(config),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email send failed (${response.status}): ${err}`);
  }

  return response.json();
}
