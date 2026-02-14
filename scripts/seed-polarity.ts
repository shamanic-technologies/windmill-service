/**
 * Seeds the 6 Polarity webinar workflows into windmill-service.
 *
 * Usage:
 *   WINDMILL_SERVICE_URL=http://localhost:3000 \
 *   WINDMILL_SERVICE_API_KEY=xxx \
 *   npx tsx scripts/seed-polarity.ts
 */

import { POLARITY_WORKFLOWS } from "../src/workflows/polarity/index.js";

const SERVICE_URL =
  process.env.WINDMILL_SERVICE_URL ?? "http://localhost:3000";
const API_KEY = process.env.WINDMILL_SERVICE_API_KEY;

if (!API_KEY) {
  console.error("WINDMILL_SERVICE_API_KEY is required");
  process.exit(1);
}

const ORG_ID = "polarity-course";
const CAMPAIGN_ID = "webinar-march-2025";

async function main() {
  console.log(`Seeding ${POLARITY_WORKFLOWS.length} Polarity workflows...`);
  console.log(`Target: ${SERVICE_URL}`);

  for (const wf of POLARITY_WORKFLOWS) {
    console.log(`\n  Creating: ${wf.name}...`);

    const res = await fetch(`${SERVICE_URL}/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({
        orgId: ORG_ID,
        campaignId: CAMPAIGN_ID,
        name: wf.name,
        description: wf.description,
        dag: wf.dag,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`  FAILED (${res.status}): ${err}`);
      continue;
    }

    const data = await res.json();
    console.log(`  OK → id=${data.id} path=${data.windmillFlowPath}`);
  }

  console.log("\nDone!");
}

main();
