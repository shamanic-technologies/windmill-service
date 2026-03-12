import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { workflowRuns } from "./db/schema.js";
import { getWindmillClient } from "./lib/windmill-client.js";
import { JobPoller } from "./lib/job-poller.js";
import { requireIdentity } from "./middleware/auth.js";
import { checkApiRegistryHealth, validateAndUpgradeWorkflows } from "./lib/startup-validator.js";
import { deployNodes } from "./lib/deploy-nodes.js";
import healthRoutes from "./routes/health.js";
import workflowsRoutes from "./routes/workflows.js";
import workflowRunsRoutes from "./routes/workflow-runs.js";
import openapiRoutes from "./routes/openapi.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// Public routes (no identity required)
app.use(healthRoutes);
app.use(openapiRoutes);

// Identity-gated routes
app.use(requireIdentity);
app.use(workflowsRoutes);
app.use(workflowRunsRoutes);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV !== "test") {
  (async () => {
    try {
      // Run migrations
      await migrate(db, { migrationsFolder: "./drizzle" });
      console.log("Migrations complete");

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

        const poller = new JobPoller(db, windmillClient, workflowRuns);
        poller.start();
      } else {
        console.log("Windmill not configured (WINDMILL_SERVER_URL / WINDMILL_SERVER_API_KEY missing) — job poller disabled");
      }

      // Validate workflows before accepting traffic — crash if broken and unfixable
      if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
        await validateAndUpgradeWorkflows({ db, windmillClient });
      }

      app.listen(Number(PORT), "::", () => {
        console.log(`workflow-service running on port ${PORT}`);
      });
    } catch (err) {
      console.error("Startup failed:", err);
      process.exit(1);
    }
  })();
}

export default app;
