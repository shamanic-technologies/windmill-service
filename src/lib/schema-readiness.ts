import type { Request, Response, NextFunction } from "express";

/**
 * Boot-time schema readiness.
 *
 * The service binds its port BEFORE running migrations so a deploy that lands
 * on a suspended Neon compute still answers Railway's healthcheck (the compute
 * takes seconds to resume, and Railway only waits ~30s before failing the
 * deploy). Binding early means the port is open while the schema may still be
 * one migration behind the code, so every DB-touching route is gated on this
 * flag until `migrate()` has completed.
 *
 * Default is "pending": a process that never declares itself ready serves 503
 * rather than querying a schema its code does not expect.
 */
export type SchemaReadiness = "pending" | "ready" | "failed";

let readiness: SchemaReadiness = "pending";
let failureReason: string | null = null;

export function getSchemaReadiness(): SchemaReadiness {
  return readiness;
}

export function getSchemaFailureReason(): string | null {
  return failureReason;
}

export function markSchemaReady(): void {
  readiness = "ready";
  failureReason = null;
}

export function markSchemaPending(): void {
  readiness = "pending";
  failureReason = null;
}

export function markSchemaFailed(reason: string): void {
  readiness = "failed";
  failureReason = reason;
}

/**
 * Gate every DB-touching route until migrations have been applied.
 * `/health` and `/openapi.json` are mounted above this and stay reachable.
 */
export function requireSchemaReady(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const state = getSchemaReadiness();
  if (state === "ready") {
    next();
    return;
  }

  res.setHeader("Retry-After", "5");
  res.status(503).json({
    error:
      state === "failed"
        ? "workflow-service cannot serve traffic — database migrations failed"
        : "workflow-service is starting — database migrations have not been applied yet",
    migrations: state,
    ...(failureReason ? { reason: failureReason } : {}),
  });
}
