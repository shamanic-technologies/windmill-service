// Windmill node script — calls client POST /anonymous-users
export async function main(
  orgId: string,
  email: string,
  firstName?: string,
  lastName?: string,
  phone?: string,
  metadata?: Record<string, unknown>,
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.CLIENT_SERVICE_URL ?? Bun.env.CLIENT_SERVICE_URL;
  const apiKey = serviceEnvs?.CLIENT_SERVICE_API_KEY ?? Bun.env.CLIENT_SERVICE_API_KEY;
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
      body: JSON.stringify({ orgId, email, firstName, lastName, phone, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client createUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
