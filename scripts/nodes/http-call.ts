// Windmill node script — generic HTTP call to any microservice.
//
// Resolves service URLs and API keys from serviceEnvs (injected via flow_input
// by windmill-service) with a fallback to Bun.env for backward compatibility.
//
// Convention: {SERVICE}_SERVICE_URL and {SERVICE}_SERVICE_API_KEY.
// Example: service "stripe" → STRIPE_SERVICE_URL, STRIPE_SERVICE_API_KEY.
export async function main(
  service: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
  serviceEnvs?: Record<string, string>,
  headers?: Record<string, string>,
) {
  // Convert service name to env var prefix: "transactional-email" → "TRANSACTIONAL_EMAIL"
  const envPrefix = service.toUpperCase().replace(/-/g, "_");
  const urlKey = `${envPrefix}_SERVICE_URL`;
  const apiKeyKey = `${envPrefix}_SERVICE_API_KEY`;

  const baseUrl = serviceEnvs?.[urlKey] ?? Bun.env[urlKey];
  const apiKey = serviceEnvs?.[apiKeyKey] ?? Bun.env[apiKeyKey];

  if (!baseUrl) {
    throw new Error(
      `Missing: ${urlKey}. ` +
      `Not found in serviceEnvs (${serviceEnvs ? Object.keys(serviceEnvs).length + " keys" : "undefined"}) ` +
      `or Bun.env.`
    );
  }

  // Build URL with query params
  let url = `${baseUrl}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `?${params}`;
  }

  // Build request — merge caller-supplied headers with defaults
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  if (apiKey) {
    reqHeaders["x-api-key"] = apiKey;
  }

  const options: RequestInit = { method, headers: reqHeaders };

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
