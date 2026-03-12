/**
 * Deploy all node scripts to Windmill.
 *
 * Reads every scripts/nodes/*.ts file, maps the filename to the
 * Windmill script path (f/nodes/<name_with_underscores>), then
 * creates or updates each script via the Windmill API.
 *
 * Idempotent: skips scripts whose content hasn't changed.
 */

import fs from "node:fs";
import path from "node:path";
import type { WindmillClient } from "./windmill-client.js";

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
  // Resolve the nodes directory relative to the project root
  const nodesDir = path.resolve(
    import.meta.dirname ?? __dirname,
    "../../scripts/nodes",
  );
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
        continue;
      }
      await client.createScript({
        path: wmPath,
        summary,
        description: "",
        content,
        language: "bun",
        parent_hash: existing.hash,
      });
      results.push({ path: wmPath, action: "updated" });
      console.log(`[workflow-service] Updated node script: ${wmPath}`);
    } else {
      await client.createScript({
        path: wmPath,
        summary,
        description: "",
        content,
        language: "bun",
      });
      results.push({ path: wmPath, action: "created" });
      console.log(`[workflow-service] Created node script: ${wmPath}`);
    }
  }

  return results;
}
