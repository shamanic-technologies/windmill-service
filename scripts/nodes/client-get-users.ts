// Windmill node script — calls client GET /anonymous-users?appId=...
export async function main(
  appId: string,
  limit?: number,
  offset?: number,
) {
  const baseUrl = Bun.env.CLIENT_SERVICE_URL;
  const apiKey = Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");

  const params = new URLSearchParams({ appId });
  if (limit) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));

  const response = await fetch(
    `${baseUrl}/anonymous-users?${params}`,
    {
      headers: {
        "x-api-key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client getUsers failed (${response.status}): ${err}`);
  }

  return response.json();
}
