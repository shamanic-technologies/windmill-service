import { Router } from "express";
import { sql } from "../db/index.js";
import { getWindmillClient } from "../lib/windmill-client.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  try {
    await sql`SELECT 1`;
    checks.db = "connected";
  } catch {
    checks.db = "disconnected";
  }

  const client = getWindmillClient();
  if (client) {
    try {
      const ok = await client.healthCheck();
      checks.windmill = ok ? "connected" : "disconnected";
    } catch {
      checks.windmill = "disconnected";
    }
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
