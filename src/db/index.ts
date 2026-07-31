import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.WORKFLOW_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("WORKFLOW_SERVICE_DATABASE_URL is required");
}

// Node 20 gives each happy-eyeballs candidate address only 250ms before moving
// on. A Neon compute resuming from scale-to-zero needs seconds, so the first
// connection after an idle period fails with `AggregateError [ETIMEDOUT]`
// before the wake completes. 5s per candidate covers the resume.
// (postgres.js `connect_timeout` already defaults to 30s and `idle_timeout`
// already defaults to never closing an idle connection — neither is worth
// setting here; see brand-service#389.)
net.setDefaultAutoSelectFamilyAttemptTimeout(5_000);

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
