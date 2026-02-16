// Windmill node script — calls client-service for contact/user management
export async function main(
  action: "create" | "get" | "list" | "update",
  appId?: string,
  contactData?: Record<string, unknown>,
  context?: {
    orgId?: string;
  }
) {
  const baseUrl = Bun.env.CLIENT_SERVICE_URL;
  const apiKey = Bun.env.CLIENT_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("CLIENT_SERVICE_URL is not set");
  if (!apiKey) throw new Error("CLIENT_SERVICE_API_KEY is not set");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };

  if (action === "create" || action === "update") {
    const response = await fetch(`${baseUrl}/anonymous-users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        appId,
        ...contactData,
      }),
    });
    return response.json();
  }

  if (action === "list") {
    const response = await fetch(
      `${baseUrl}/anonymous-users?appId=${appId}`,
      { headers }
    );
    return response.json();
  }

  if (action === "get" && contactData?.id) {
    const response = await fetch(
      `${baseUrl}/anonymous-users/${contactData.id}`,
      { headers }
    );
    return response.json();
  }

  throw new Error(`Unknown client-service action: ${action}`);
}
