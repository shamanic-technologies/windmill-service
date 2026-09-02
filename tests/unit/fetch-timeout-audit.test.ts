import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every outbound fetch in this repo must carry an AbortSignal with a >=10min
 * deadline. Bun's default fetch idle timeout (~5min) kills the connection
 * mid-flight for long-running downstreams (RAG ranking, heavy enrichment),
 * which surfaces as `TimeoutError` step failures in Windmill flows.
 */

const TIMEOUT_LITERAL = "AbortSignal.timeout(600_000)";

/**
 * Files whose fetches are deliberately given a SHORTER deadline, and why.
 *
 * The 10-minute default exists for our OWN long-running downstreams. A call to a
 * third party on a path that degrades rather than fails must not hold a run open
 * for ten minutes to learn the same thing a few seconds tells it — so these are
 * held to "every fetch is bounded" rather than to the default bound.
 */
const SHORT_DEADLINE_FILES = new Map([
  [
    "src/lib/ai-meeting-booking-dag.ts",
    "Calendly's public booking API — unreadable availability degrades to the plain booking link, so a long hang would only delay the prospect's answer.",
  ],
]);

const ANY_TIMEOUT_LITERAL = "AbortSignal.timeout(";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function countOutboundFetchCalls(source: string): number {
  // Count `fetch(` occurrences that are outbound HTTP calls (excluding
  // res.text/json and method declarations). Whitespace-tolerant.
  const matches = source.match(/(^|\s|=|\()fetch\(/g);
  return matches ? matches.length : 0;
}

function countTimeoutMarkers(source: string): number {
  return source.split(TIMEOUT_LITERAL).length - 1;
}

describe("fetch-timeout audit", () => {
  const targets = [
    ...listTsFiles(join(REPO_ROOT, "scripts", "nodes")),
    ...listTsFiles(join(REPO_ROOT, "src", "lib")),
  ];

  for (const filePath of targets) {
    const source = readFileSync(filePath, "utf8");
    const fetchCount = countOutboundFetchCalls(source);
    if (fetchCount === 0) continue;

    const relPath = filePath.slice(REPO_ROOT.length + 1);
    if (SHORT_DEADLINE_FILES.has(relPath)) {
      it(`${relPath} — every fetch is bounded (${SHORT_DEADLINE_FILES.get(relPath)})`, () => {
        const bounded = source.split(ANY_TIMEOUT_LITERAL).length - 1;
        expect(bounded).toBeGreaterThanOrEqual(fetchCount);
      });
      continue;
    }

    it(`${relPath} — every fetch has AbortSignal.timeout(600_000)`, () => {
      const timeoutCount = countTimeoutMarkers(source);
      expect(timeoutCount).toBeGreaterThanOrEqual(fetchCount);
    });
  }
});
