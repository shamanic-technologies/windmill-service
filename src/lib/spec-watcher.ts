import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { workflows } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { DAG } from "./dag-validator.js";
import { extractHttpEndpoints } from "./extract-http-endpoints.js";
import { fetchServiceList, fetchSpecsForServices } from "./api-registry-client.js";
import { validateWorkflowEndpoints } from "./validate-workflow-endpoints.js";
import type { WindmillClient } from "./windmill-client.js";

type Database = typeof DbInstance;

interface SpecWatcherDeps {
  db: Database;
  windmillClient: WindmillClient | null;
}

// 1 hour. NOT tunable down without re-checking the Neon bill: a tick that
// reaches Postgres on a period shorter than the compute's idle timeout (300s)
// holds the compute open permanently and scale-to-zero never engages. Spec
// drift does not need minute-level granularity — boot already validates, and
// upgrades can be triggered on demand.
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Watches for OpenAPI spec changes once an hour.
 *
 * A tick that finds no drift **never touches the database**: the set of service
 * names referenced by active workflows is cached in memory, so the steady-state
 * check is HTTP + a CPU hash comparison and the Neon compute can still reach its
 * idle timeout. Postgres is read only when the cache is cold or when the specs
 * genuinely changed and the DAGs are needed to validate them.
 *
 * The cache is dropped by `invalidateSpecWatcherCache()` on every workflow
 * write, so a newly referenced service is picked up on the next tick. Missing
 * an invalidation delays a warning log; it cannot corrupt anything.
 */
export class SpecWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSpecsHash: string | null = null;
  private running = false;
  private deps: SpecWatcherDeps;
  /**
   * Service names referenced by active workflows. `null` = cold, must be read
   * from the database. Kept in memory precisely so the common (no-drift) tick
   * issues no query at all.
   */
  private cachedServiceNames: string[] | null = null;

  constructor(deps: SpecWatcherDeps) {
    this.deps = deps;
  }

  /** Drop the cached service set — the next check re-reads it from the DB. */
  invalidateWorkflowCache(): void {
    this.cachedServiceNames = null;
  }

  start(): void {
    if (this.timer) return;
    console.log("[workflow-service] SpecWatcher started — checking every 60 minutes");
    this.timer = setInterval(() => void this.check(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[workflow-service] SpecWatcher stopped");
    }
  }

  /**
   * Run one check cycle. Safe to call manually (e.g. after startup validation).
   * Stores the current spec hash so the first interval tick can detect drift.
   */
  async check(): Promise<void> {
    if (this.running) {
      console.log("[workflow-service] SpecWatcher: previous check still running — skipping");
      return;
    }

    this.running = true;
    try {
      await this.doCheck();
    } catch (err) {
      console.error(
        "[workflow-service] SpecWatcher check failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.running = false;
    }
  }

  /** Read the service set from the database. Only called on a cold cache. */
  private async loadServiceNames(): Promise<string[]> {
    const activeWorkflows = await this.deps.db
      .select()
      .from(workflows)
      .where(eq(workflows.status, "active"));

    return collectServiceNames(activeWorkflows);
  }

  private async doCheck(): Promise<void> {
    // 0. Verify API Registry is reachable before anything.
    // If it's down, spec fetches will fail and we'd wrongly flag valid endpoints as broken.
    try {
      await fetchServiceList();
    } catch (err) {
      console.error(
        "[workflow-service] SpecWatcher: API Registry unreachable — skipping check cycle.",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    // 1. Which services do active workflows call? Served from memory whenever
    //    possible — reading this on every tick is what used to pin the compute.
    if (this.cachedServiceNames === null) {
      this.cachedServiceNames = await this.loadServiceNames();
    }
    const serviceNames = this.cachedServiceNames;

    if (serviceNames.length === 0) return;

    // 2. Fetch current specs from API Registry
    const specs = await fetchSpecsForServices(serviceNames);

    // 3. Hash the specs — deterministic JSON serialization by sorting keys
    const specsHash = hashSpecs(specs);

    // First run: store baseline, no upgrade needed (startup already validated)
    if (this.lastSpecsHash === null) {
      this.lastSpecsHash = specsHash;
      console.log("[workflow-service] SpecWatcher: baseline hash stored");
      return;
    }

    // No change — nothing to do, and notably no query was issued to get here.
    if (specsHash === this.lastSpecsHash) return;

    console.log("[workflow-service] SpecWatcher: spec change detected — validating workflows");
    this.lastSpecsHash = specsHash;

    // 4. The specs really moved, so the DAGs are needed. This is the only path
    //    that reads the database, and it re-primes the cache while it is there.
    const activeWorkflows = await this.deps.db
      .select()
      .from(workflows)
      .where(eq(workflows.status, "active"));

    this.cachedServiceNames = collectServiceNames(activeWorkflows);

    if (activeWorkflows.length === 0) return;

    // 5. Quick validation pass (free, rule-based)
    let hasIssues = false;
    for (const wf of activeWorkflows) {
      const result = validateWorkflowEndpoints(wf.dag as DAG, specs);
      if (!result.valid || result.fieldIssues.length > 0) {
        hasIssues = true;
        console.log(
          `[workflow-service] SpecWatcher: workflow "${wf.workflowSlug}" has issues — triggering upgrade`,
        );
        break;
      }
    }

    if (!hasIssues) {
      console.log("[workflow-service] SpecWatcher: specs changed but all workflows still valid");
      return;
    }

    // LLM auto-upgrade DISABLED — was burning Gemini credits on every tick.
    // Just log the issue; do NOT call validateAndUpgradeWorkflows which triggers LLM.
    console.warn(
      "[workflow-service] SpecWatcher: spec change broke workflow(s) — LLM upgrade disabled, skipping",
    );
  }
}

/**
 * The single watcher owned by `boot()`. Null when the API Registry is not
 * configured — no watcher runs in that case, so there is no cache to drop.
 */
let sharedWatcher: SpecWatcher | null = null;

export function setSpecWatcher(watcher: SpecWatcher | null): void {
  sharedWatcher = watcher;
}

/**
 * Called when a workflow is written. The watcher caches the set of services its
 * active workflows call so a quiet tick issues no query; a write can change that
 * set, so it is dropped here and re-read on the next tick.
 */
export function invalidateSpecWatcherCache(): void {
  sharedWatcher?.invalidateWorkflowCache();
}

/** Service names referenced by the given workflows' DAGs. */
function collectServiceNames(activeWorkflows: { dag: unknown }[]): string[] {
  const serviceNames = new Set<string>();
  for (const wf of activeWorkflows) {
    for (const ep of extractHttpEndpoints(wf.dag as DAG)) {
      serviceNames.add(ep.service);
    }
  }
  return [...serviceNames];
}

/**
 * Deterministic hash of a Map of specs.
 * Deep-sorts all object keys for stability.
 */
function hashSpecs(specs: Map<string, Record<string, unknown>>): string {
  const sorted = [...specs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => [name, stableStringify(spec)]);

  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** JSON.stringify with sorted keys at every nesting level */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}
