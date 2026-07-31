import { Router } from "express";
import { sql } from "../db/index.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import {
  getSchemaFailureReason,
  getSchemaReadiness,
} from "../lib/schema-readiness.js";

const router = Router();

// Every dependency probe is bounded: Railway fails a healthcheck attempt after
// a few seconds, and a Neon compute resuming from scale-to-zero can hold a
// connection open far longer than that.
const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe timed out")), ms);
    });
    return { ok: true, value: await Promise.race([work, timeout]) };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

router.get("/health", async (_req, res) => {
  const migrations = getSchemaReadiness();

  // Startup: the port is bound before migrations run so the deploy can pass its
  // healthcheck while the database compute resumes. Do NOT probe the DB here —
  // that is exactly the call that blocks for seconds on a cold compute. Business
  // routes stay gated (503) until migrations land, so a 200 here never means
  // traffic is being served against an unmigrated schema.
  if (migrations === "pending") {
    res.status(200).json({
      status: "starting",
      service: "workflow-service",
      migrations,
      db: "starting",
      windmill: "not_checked",
    });
    return;
  }

  if (migrations === "failed") {
    res.status(503).json({
      status: "degraded",
      service: "workflow-service",
      migrations,
      reason: getSchemaFailureReason() ?? "migrations failed",
      db: "unknown",
      windmill: "not_checked",
    });
    return;
  }

  const checks: Record<string, string> = { migrations };

  const dbProbe = await withTimeout(sql`SELECT 1`, PROBE_TIMEOUT_MS);
  checks.db = dbProbe.ok ? "connected" : "disconnected";

  const client = getWindmillClient();
  if (client) {
    const windmillProbe = await withTimeout(client.healthCheck(), PROBE_TIMEOUT_MS);
    checks.windmill =
      windmillProbe.ok && windmillProbe.value ? "connected" : "disconnected";
  } else {
    checks.windmill = "not_configured";
  }

  const allOk = checks.db === "connected";

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    service: "workflow-service",
    ...checks,
  });
});

export default router;
