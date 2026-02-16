/**
 * Deploy all node scripts to Windmill.
 *
 * Reads every scripts/nodes/*.ts file, maps the filename to the
 * Windmill script path (f/nodes/<name_with_underscores>), then
 * creates or updates each script via the Windmill API.
 *
 * Usage:
 *   WINDMILL_SERVER_URL=... WINDMILL_SERVER_API_KEY=... npx tsx scripts/deploy-nodes.ts
 *
 * Or with a .env file already loaded.
 */

import fs from "node:fs";
import path from "node:path";
import { WindmillClient } from "../src/lib/windmill-client.js";

function filenameToWindmillPath(filename: string): string {
  const name = filename.replace(/\.ts$/, "").replace(/-/g, "_");
  return `f/nodes/${name}`;
}

function filenameToSummary(filename: string): string {
  return filename
    .replace(/\.ts$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function deployNodes(client: WindmillClient): Promise<
  { path: string; action: "created" | "updated" }[]
> {
  const nodesDir = path.resolve(import.meta.dirname ?? __dirname, "nodes");
  const files = fs.readdirSync(nodesDir).filter((f) => f.endsWith(".ts"));

  const results: { path: string; action: "created" | "updated" }[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(nodesDir, file), "utf-8");
    const wmPath = filenameToWindmillPath(file);
    const summary = filenameToSummary(file);

    const existing = await client.getScript(wmPath);

    if (existing) {
      // Content unchanged — skip
      if (existing.content.trim() === content.trim()) {
        console.log(`  skip  ${wmPath} (unchanged)`);
        continue;
      }
      await client.createScript({
        path: wmPath,
        summary,
        content,
        language: "bun",
        parent_hash: existing.hash,
      });
      results.push({ path: wmPath, action: "updated" });
      console.log(`  update ${wmPath}`);
    } else {
      await client.createScript({
        path: wmPath,
        summary,
        content,
        language: "bun",
      });
      results.push({ path: wmPath, action: "created" });
      console.log(`  create ${wmPath}`);
    }
  }

  return results;
}

// --- CLI entry point (skipped when imported as module in tests) ---
const isCLI = process.argv[1]?.endsWith("deploy-nodes.ts");

async function cliMain() {
  const baseUrl = process.env.WINDMILL_SERVER_URL;
  const token = process.env.WINDMILL_SERVER_API_KEY;
  const workspace = process.env.WINDMILL_SERVER_WORKSPACE;

  if (!baseUrl || !token) {
    console.error("Missing WINDMILL_SERVER_URL or WINDMILL_SERVER_API_KEY");
    process.exit(1);
  }

  const client = new WindmillClient({ baseUrl, token, workspace });

  console.log(`Deploying node scripts to ${baseUrl} (workspace: ${workspace ?? "prod"})...`);
  const results = await deployNodes(client);
  console.log(`\nDone: ${results.length} script(s) deployed.`);
}

if (isCLI) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
