// Windmill node script — calls client POST /anonymous-users
export async function main(
  appId: string,
  email: string,
  firstName?: string,
  lastName?: string,
  phone?: string,
  orgId?: string,
  metadata?: Record<string, unknown>,
) {
  const baseUrl = Bun.env.CLIENT_SERVICE_URL;
  const apiKey = Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/anonymous-users`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ appId, email, firstName, lastName, phone, orgId, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client createUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
