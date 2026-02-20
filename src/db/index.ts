import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.WORKFLOW_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("WORKFLOW_SERVICE_DATABASE_URL is required");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
