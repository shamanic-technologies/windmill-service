/**
 * Centralized header forwarding for all downstream service calls.
 *
 * Every service-to-service call from an authenticated route MUST forward
 * these headers so downstream services have full tracing context.
 */

/** All known contextual headers that flow between services. */
const DOWNSTREAM_HEADER_KEYS = [
  "x-org-id",
  "x-user-id",
  "x-run-id",
  "x-brand-id",
  "x-campaign-id",
  "x-workflow-slug",
  "x-feature-slug",
  "x-goal",
  "x-brand-profile-id",
  "x-customer-persona-id",
  "x-customer-profile-id",
  "x-profile-id",
  "x-persona-id",
  "x-goal-id",
  "x-goal-slug",
  "x-optimization-goal",
] as const;

/** Headers to forward to downstream services. Spread into fetch headers. */
export type DownstreamHeaders = Record<string, string>;

/**
 * Extract all contextual headers from an Express request for forwarding.
 * Picks every known `x-*` header that has a string value.
 */
export function extractDownstreamHeaders(
  req: { headers: Record<string, string | string[] | undefined> },
): DownstreamHeaders {
  const result: DownstreamHeaders = {};
  for (const key of DOWNSTREAM_HEADER_KEYS) {
    const value = req.headers[key];
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
