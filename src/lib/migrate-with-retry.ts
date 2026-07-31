/**
 * Retry `migrate()` while the database compute is still resuming.
 *
 * Neon suspends an idle compute and takes seconds to resume. A deploy that
 * lands during that window gets a connect-phase rejection (CONNECT_TIMEOUT,
 * ECONNREFUSED, ECONNRESET, …) on the very first connection — nothing has run
 * yet, so retrying is write-safe.
 *
 * A migration that actually FAILS (bad SQL, a constraint violation, a lock
 * timeout) is NOT retried and NOT swallowed: it propagates immediately so the
 * caller can fail loudly. Only connect-phase failures are retried, and only
 * until the deadline.
 */

/** Error codes that mean "the connection never got established". */
const TRANSIENT_CODES = new Set([
  // postgres.js
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  // node net / dns
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/** Connect-phase failures that only carry a message, no code. */
const TRANSIENT_MESSAGE =
  /timeout expired|timeout exceeded when trying to connect|connection terminated|terminating connection due to administrator command|the database system is (starting up|not yet accepting connections)|could not connect|getaddrinfo/i;

function codeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Walk `cause` chains and AggregateError members — Node 20's happy-eyeballs
 * wraps per-address ETIMEDOUTs in an AggregateError, and postgres.js wraps the
 * socket error as `cause`.
 */
export function isTransientConnectError(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;

  const code = codeOf(err);
  if (code && TRANSIENT_CODES.has(code)) return true;

  if (err instanceof Error && TRANSIENT_MESSAGE.test(err.message)) return true;

  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    if (err.errors.some((sub) => isTransientConnectError(sub, depth + 1))) return true;
  }

  if (typeof err === "object" && err !== null && "cause" in err) {
    return isTransientConnectError((err as { cause?: unknown }).cause, depth + 1);
  }

  return false;
}

export interface MigrateRetryOptions {
  /** Stop retrying transient failures after this many ms. */
  deadlineMs?: number;
  /** First backoff step; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function migrateWithRetry(
  runMigrations: () => Promise<void>,
  options: MigrateRetryOptions = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? 120_000;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((m: string) => console.warn(m));

  const startedAt = now();
  let delay = initialDelayMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await runMigrations();
      return;
    } catch (err) {
      // A real migration failure must surface immediately — never retried,
      // never swallowed.
      if (!isTransientConnectError(err)) throw err;

      const elapsed = now() - startedAt;
      if (elapsed + delay >= deadlineMs) {
        throw err;
      }

      log(
        `[workflow-service] Database not reachable yet (attempt ${attempt}, ${Math.round(
          elapsed,
        )}ms elapsed) — the compute is likely resuming. Retrying in ${delay}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
