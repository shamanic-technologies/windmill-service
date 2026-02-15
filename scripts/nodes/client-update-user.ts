// Windmill node script — calls client PATCH /anonymous-users/:id
export async function main(
  config: {
    userId: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    clerkUserId?: string | null;
    orgId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
) {
  const baseUrl = Bun.env.CLIENT_SERVICE_URL;
  const apiKey = Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");

  const { userId, ...body } = config;

  const response = await fetch(
    `${baseUrl}/anonymous-users/${userId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client updateUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
