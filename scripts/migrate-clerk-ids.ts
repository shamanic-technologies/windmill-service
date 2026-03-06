/**
 * One-time migration: resolve Clerk org IDs → internal UUIDs in the workflows table.
 *
 * Finds all rows where org_id looks like a Clerk ID (starts with "org_"),
 * resolves each to an internal UUID via client-service, and updates the row.
 *
 * Usage:
 *   CLIENT_SERVICE_URL=https://client.distribute.org \
 *   CLIENT_SERVICE_API_KEY=xxx \
 *   WORKFLOW_SERVICE_DATABASE_URL=postgresql://... \
 *   npx tsx scripts/migrate-clerk-ids.ts
 *
 * Add --dry-run to preview changes without writing.
 */

import { db } from "../src/db/index.js";
import { workflows } from "../src/db/schema.js";
import { sql } from "drizzle-orm";

const CLIENT_SERVICE_URL = process.env.CLIENT_SERVICE_URL;
const CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

if (!CLIENT_SERVICE_URL || !CLIENT_SERVICE_API_KEY) {
  console.error("CLIENT_SERVICE_URL and CLIENT_SERVICE_API_KEY must be set");
  process.exit(1);
}

async function resolveClerkOrgId(clerkOrgId: string): Promise<string | null> {
  const res = await fetch(`${CLIENT_SERVICE_URL}/orgs/by-clerk/${clerkOrgId}`, {
    headers: {
      "x-api-key": CLIENT_SERVICE_API_KEY!,
      "x-org-id": "system",
      "x-user-id": "system",
      "x-run-id": "migrate-clerk-ids",
    },
  });

  if (!res.ok) {
    console.error(`  Failed to resolve ${clerkOrgId}: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = (await res.json()) as { org: { id: string } };
  return data.org.id;
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE MIGRATION ===");

  // Find all workflows with Clerk-style org_id
  const clerkRows = await db
    .select({ id: workflows.id, orgId: workflows.orgId })
    .from(workflows)
    .where(sql`${workflows.orgId} LIKE 'org_%'`);

  console.log(`Found ${clerkRows.length} workflows with Clerk org IDs`);

  if (clerkRows.length === 0) {
    console.log("Nothing to migrate.");
    process.exit(0);
  }

  // Deduplicate Clerk IDs
  const uniqueClerkIds = [...new Set(clerkRows.map((r) => r.orgId))];
  console.log(`Unique Clerk org IDs: ${uniqueClerkIds.join(", ")}`);

  // Resolve each Clerk ID → internal UUID
  const clerkToUuid = new Map<string, string>();
  for (const clerkId of uniqueClerkIds) {
    const uuid = await resolveClerkOrgId(clerkId);
    if (uuid) {
      clerkToUuid.set(clerkId, uuid);
      console.log(`  ${clerkId} → ${uuid}`);
    } else {
      console.error(`  ${clerkId} → FAILED (skipping)`);
    }
  }

  // Update rows
  let updated = 0;
  let skipped = 0;

  for (const row of clerkRows) {
    const uuid = clerkToUuid.get(row.orgId);
    if (!uuid) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] Would update workflow ${row.id}: ${row.orgId} → ${uuid}`);
    } else {
      await db
        .update(workflows)
        .set({ orgId: uuid })
        .where(sql`${workflows.id} = ${row.id}`);
      console.log(`  Updated workflow ${row.id}: ${row.orgId} → ${uuid}`);
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
