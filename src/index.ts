import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { workflowRuns } from "./db/schema.js";
import { getWindmillClient } from "./lib/windmill-client.js";
import { JobPoller, setJobPoller } from "./lib/job-poller.js";
import { PeriodicCleanup } from "./lib/periodic-cleanup.js";
import { requireIdentity } from "./middleware/auth.js";
import { checkApiRegistryHealth, validateAndUpgradeWorkflows } from "./lib/startup-validator.js";
import { assertEnvironmentConsistency } from "./lib/env-safety.js";
import { migrateWithRetry } from "./lib/migrate-with-retry.js";
import {
  markSchemaFailed,
  markSchemaPending,
  markSchemaReady,
  requireSchemaReady,
} from "./lib/schema-readiness.js";
import { deployNodes } from "./lib/deploy-nodes.js";
import { SpecWatcher } from "./lib/spec-watcher.js";
import healthRoutes from "./routes/health.js";
import workflowsRoutes from "./routes/workflows.js";
import workflowRunsRoutes from "./routes/workflow-runs.js";
import openapiRoutes from "./routes/openapi.js";
import publicWorkflowsRoutes from "./routes/public-workflows.js";
import internalRoutes from "./routes/internal.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// Static routes — reachable before migrations have been applied.
app.use(healthRoutes);
app.use(openapiRoutes);

// Everything below touches the database. It stays 503 until migrations land,
// so the early port-bind can never serve traffic against an unmigrated schema.
app.use(requireSchemaReady);

// Public routes (no identity required)
app.use(publicWorkflowsRoutes);

// Internal routes (x-api-key only, no identity headers)
app.use(internalRoutes);

// Identity-gated routes
app.use(requireIdentity);
app.use(workflowsRoutes);
app.use(workflowRunsRoutes);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

let periodicCleanup: PeriodicCleanup | null = null;

/**
 * Work that must happen before the service can answer requests, plus the
 * background workers. Runs AFTER `app.listen()` — a Neon compute resuming from
 * scale-to-zero takes seconds to accept its first connection, and Railway
 * fails the deploy if the port is not open within ~30s.
 */
async function boot(): Promise<void> {
  try {
    await migrateWithRetry(() => migrate(db, { migrationsFolder: "./drizzle" }));
    console.log("Migrations complete");
    markSchemaReady();
  } catch (err) {
    // Not a cold compute — the schema is genuinely wrong. Never serve traffic
    // against it: fail loud and let Railway surface the crash.
    markSchemaFailed(err instanceof Error ? err.message : String(err));
    console.error("FATAL: database migrations failed — refusing to serve traffic:", err);
    process.exit(1);
  }

  // Verify API Registry is reachable — fail fast if not
  if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
    try {
      await checkApiRegistryHealth();
      console.log("API Registry health check passed");
    } catch (err) {
      console.error("API Registry is unreachable — aborting startup:", err);
      process.exit(1);
    }
  } else {
    console.warn("API_REGISTRY_SERVICE_URL / API_REGISTRY_SERVICE_API_KEY not set — skipping API Registry health check");
  }

  // Start job poller (only if Windmill is configured)
  const windmillClient = getWindmillClient();
  if (windmillClient) {
    // Set instance-wide retention for Windmill completed_job rows.
    // 7 days = 604_800 s. CE caps at 30 days; our value is well under.
    // Requires the API token to be superadmin — fail loud (warn) if not,
    // but do not block boot: cleanup still works without retention set.
    try {
      await windmillClient.setGlobalSetting("retention_period_secs", 604800);
      console.log("[workflow-service] Windmill retention_period_secs set to 604800 (7 days)");
    } catch (err) {
      console.warn(
        "[workflow-service] Failed to set Windmill retention_period_secs — token may not be superadmin:",
        err instanceof Error ? err.message : err,
      );
    }

    // Sync node scripts to Windmill — idempotent, skips unchanged scripts
    try {
      const deployed = await deployNodes(windmillClient);
      if (deployed.length > 0) {
        console.log(`[workflow-service] Deployed ${deployed.length} node script(s) to Windmill`);
      }
    } catch (err) {
      console.error("[workflow-service] Failed to deploy node scripts to Windmill:", err);
      process.exit(1);
    }

    // One poll at boot reconciles anything left running across a restart; the
    // poller then idles itself until a run is dispatched.
    const poller = new JobPoller(db, windmillClient, workflowRuns);
    setJobPoller(poller);
    poller.start();

    // Periodic cleanup: re-runs stale-deprecation + Windmill orphan-flow
    // cleanup every 24h. Boot already runs them once in validateAndUpgradeWorkflows;
    // this keeps the system tidy without requiring service restarts.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    periodicCleanup = new PeriodicCleanup(db, windmillClient, ONE_DAY_MS);
    periodicCleanup.start();
  } else {
    console.log("Windmill not configured (WINDMILL_SERVER_URL / WINDMILL_SERVER_API_KEY missing) — job poller disabled");
  }

  // Validate & upgrade workflows last — the service already serves traffic
  // while upgrades run (they take minutes and cost LLM calls).
  if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
    try {
      await validateAndUpgradeWorkflows({ db, windmillClient });
    } catch (err) {
      console.error("[workflow-service] Workflow validation/upgrade failed:", err);
      // Don't crash — workflows with issues are kept active and logged above
    }

    // Start SpecWatcher — checks every 5 min if OpenAPI specs changed,
    // triggers workflow upgrades only when a spec change breaks a workflow.
    // The check itself is free (HTTP + hash comparison), LLM only on upgrade.
    const specWatcher = new SpecWatcher({ db, windmillClient });
    await specWatcher.check(); // Store baseline hash (no-op on first call)
    specWatcher.start();
  }
}

if (process.env.NODE_ENV !== "test") {
  // Fail loud before any side-effect if env URLs cross production/staging
  // boundaries. Pure env inspection — no I/O, safe to keep before listen().
  assertEnvironmentConsistency();

  markSchemaPending();

  const shutdown = (signal: string) => {
    console.log(`[workflow-service] ${signal} received — shutting down`);
    periodicCleanup?.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  app.listen(Number(PORT), "::", () => {
    console.log(`workflow-service running on port ${PORT}`);
  });

  boot().catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
} else {
  // Tests mount the app directly and never run boot().
  markSchemaReady();
}

export default app;
