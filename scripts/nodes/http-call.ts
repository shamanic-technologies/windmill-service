// Windmill node script — generic HTTP call to any microservice.
//
// Resolves service URLs and API keys from environment variables using the
// convention: {SERVICE}_SERVICE_URL and {SERVICE}_SERVICE_API_KEY.
// Example: service "stripe" → STRIPE_SERVICE_URL, STRIPE_SERVICE_API_KEY.
//
// This avoids hardcoding one script per service endpoint. Clients specify
// the service name, HTTP method, and path — this script does the rest.
export async function main(
  service: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
) {
  // Convert service name to env var prefix: "transactional-email" → "TRANSACTIONAL_EMAIL"
  const envPrefix = service.toUpperCase().replace(/-/g, "_");
  const baseUrl = Bun.env[`${envPrefix}_SERVICE_URL`];
  const apiKey = Bun.env[`${envPrefix}_SERVICE_API_KEY`];

  if (!baseUrl) {
    throw new Error(
      `Missing env var: ${envPrefix}_SERVICE_URL. ` +
      `Make sure the "${service}" service URL is configured on the Windmill worker.`
    );
  }

  // Build URL with query params
  let url = `${baseUrl}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `?${params}`;
  }

  // Build request
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const options: RequestInit = { method, headers };

  if (body && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `${method} ${service}${path} failed (${response.status}): ${err}`
    );
  }

  // Handle empty responses (204 No Content, etc.)
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
