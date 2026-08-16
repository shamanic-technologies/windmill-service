import type { DAG } from "./dag-validator.js";
import { validateDAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { fetchSpecsForServices } from "./api-registry-client.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import type { DownstreamHeaders } from "./downstream-headers.js";

/** A 400 body, ready to serialize, or null when the DAG is acceptable. */
export interface ClientDagRejection {
  error: string;
  details: unknown;
}

/**
 * The gate every client-supplied DAG passes before it is stored.
 *
 * Two checks, and the second is the one that used to be missing on the write
 * paths. `validateDAG` reads topology — nodes exist, edges connect them, no
 * cycles — and says nothing about whether the endpoints those nodes call are
 * real. `validateWorkflowEndpoints` resolves each `http.call` against the
 * service's live OpenAPI spec: the path and method must exist, required body
 * fields must be present, and a literal body value must satisfy any closed set
 * (`enum` / `const`) the target schema declares.
 *
 * Only the LLM generation path ran the second check. A DAG handed to us by a
 * client — `POST /workflows`, `POST /workflows/upgrade` with `dag`, or the
 * `PUT /workflows/:id` update and fork paths — was stored on topology alone.
 * That is how three workflows came to carry `"model": "deepseek-flash-v4"`, an
 * alias content-generation's schema does not list: shape-valid, and rejected by
 * the service on every call. Since a stored DAG is executed as-is, the write is
 * the last place the mistake is cheap to catch.
 *
 * A spec that could not be fetched is NOT treated as a failed validation. The
 * generator has always warned and continued there, and blocking every workflow
 * write on the registry being up is a much larger change than closing this gap.
 *
 * That boundary is drawn wider than it looks, and deliberately so.
 * `fetchSpecsForServices` settles every fetch and returns only what succeeded,
 * so a service missing from the map is EITHER unknown to the registry OR a
 * service whose fetch failed — the map alone cannot tell the two apart. Reading
 * every absence as "unknown service" would 400 every workflow write during a
 * registry blip. So any absence skips the endpoint check for this DAG, and the
 * skipped services are named in the log. The check still bites where it must:
 * when the registry answers for every service the DAG calls, which is the case
 * that let `"model": "deepseek-flash-v4"` through. A DAG calling a service that
 * genuinely does not exist is still caught by `POST /workflows/:id/validate`,
 * the boot validator and the spec watcher, all of which report it as such.
 */
export async function validateClientDag(
  dag: DAG,
  downstreamHeaders: DownstreamHeaders,
): Promise<ClientDagRejection | null> {
  const topology = validateDAG(dag);
  if (!topology.valid) {
    return { error: "Invalid DAG", details: topology.errors };
  }

  const httpEndpoints = extractHttpEndpoints(dag);
  if (httpEndpoints.length === 0) return null;

  const serviceNames = [...new Set(httpEndpoints.map((e) => e.service))];
  let specs: Map<string, Record<string, unknown>>;
  try {
    specs = await fetchSpecsForServices(serviceNames, downstreamHeaders);
  } catch (err) {
    console.warn(
      "[workflow-service] endpoint validation skipped (API Registry unreachable):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const missing = serviceNames.filter((s) => !specs.has(s));
  if (missing.length > 0) {
    console.warn(
      `[workflow-service] endpoint validation skipped — no spec for: ${missing.join(", ")}`,
    );
    return null;
  }

  const result = validateWorkflowEndpoints(dag, specs);
  if (result.valid) return null;

  return {
    error: "DAG endpoint validation failed",
    details: {
      invalidEndpoints: result.invalidEndpoints,
      // Warnings are advisory and never flip `valid`; surfacing them in a
      // rejection would read as though they had to be fixed.
      fieldIssues: result.fieldIssues.filter((f) => f.severity === "error"),
    },
  };
}
