// Windmill node script — generic HTTP call to any microservice.
//
// Resolves service URLs and API keys from serviceEnvs (injected via flow_input
// by workflow-service) with a fallback to Bun.env for backward compatibility.
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
  validateResponse?: { field: string; equals: unknown },
  orgId?: string,
  userId?: string,
  runId?: string,
  params?: Record<string, string>,
  campaignId?: string,
  brandId?: string,
  workflowName?: string,
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

  // Resolve path parameters: "/brands/{brandId}/profile" or "/brands/:brandId/profile"
  // + params.brandId → "/brands/abc/profile"
  let resolvedPath = path;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const encoded = encodeURIComponent(String(value));
      resolvedPath = resolvedPath.replace(`{${key}}`, encoded);
      resolvedPath = resolvedPath.replace(`:${key}`, encoded);
    }
  }

  // Build URL with query params
  let url = `${baseUrl}${resolvedPath}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `?${params}`;
  }

  // Build request — identity headers + caller-supplied headers, then resolved x-api-key wins
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (brandId) reqHeaders["x-brand-id"] = brandId;
  if (workflowName) reqHeaders["x-workflow-name"] = workflowName;
  // Caller-supplied headers can override identity headers
  if (headers) Object.assign(reqHeaders, headers);
  // Resolved x-api-key always takes precedence
  if (apiKey) reqHeaders["x-api-key"] = apiKey;

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

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }

  // Validate response field if configured — throws to stop the flow and trigger onError
  if (validateResponse) {
    const actual = result[validateResponse.field];
    if (actual !== validateResponse.equals) {
      throw new Error(
        `${method} ${service}${path} validation failed: ` +
        `expected ${validateResponse.field}=${JSON.stringify(validateResponse.equals)}, ` +
        `got ${JSON.stringify(actual)}`
      );
    }
  }

  return result;
}
