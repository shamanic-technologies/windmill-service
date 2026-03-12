/**
 * CLI wrapper for deploying node scripts to Windmill.
 *
 * Usage:
 *   WINDMILL_SERVER_URL=... WINDMILL_SERVER_API_KEY=... npx tsx scripts/deploy-nodes.ts
 *
 * The core logic lives in src/lib/deploy-nodes.ts (also called on service startup).
 */

import { WindmillClient } from "../src/lib/windmill-client.js";
import { deployNodes } from "../src/lib/deploy-nodes.js";

export { deployNodes } from "../src/lib/deploy-nodes.js";

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
