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

// 1 hour. NOT tunable down without re-checking the Neon bill: every tick opens
// with a `SELECT` over active workflows, so a period shorter than the compute's
// idle timeout (300s) holds the compute open permanently and scale-to-zero
// never engages. Spec drift does not need minute-level granularity — boot
// already validates, and upgrades can be triggered on demand.
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Watches for OpenAPI spec changes once an hour.
 * The check itself is free (HTTP + CPU hash comparison).
 * Only triggers LLM-powered upgrades when specs actually changed
 * AND the change breaks an active workflow.
 */
export class SpecWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSpecsHash: string | null = null;
  private running = false;
  private deps: SpecWatcherDeps;

  constructor(deps: SpecWatcherDeps) {
    this.deps = deps;
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

    // 1. Fetch all active workflows
    const activeWorkflows = await this.deps.db
      .select()
      .from(workflows)
      .where(eq(workflows.status, "active"));

    if (activeWorkflows.length === 0) return;

    // 2. Collect all service names referenced by active workflows
    const serviceNames = new Set<string>();
    for (const wf of activeWorkflows) {
      for (const ep of extractHttpEndpoints(wf.dag as DAG)) {
        serviceNames.add(ep.service);
      }
    }

    if (serviceNames.size === 0) return;

    // 3. Fetch current specs from API Registry
    const specs = await fetchSpecsForServices([...serviceNames]);

    // 4. Hash the specs — deterministic JSON serialization by sorting keys
    const specsHash = hashSpecs(specs);

    // First run: store baseline, no upgrade needed (startup already validated)
    if (this.lastSpecsHash === null) {
      this.lastSpecsHash = specsHash;
      console.log("[workflow-service] SpecWatcher: baseline hash stored");
      return;
    }

    // No change — nothing to do
    if (specsHash === this.lastSpecsHash) return;

    console.log("[workflow-service] SpecWatcher: spec change detected — validating workflows");
    this.lastSpecsHash = specsHash;

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
