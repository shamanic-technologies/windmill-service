import type { db as DbInstance } from "../db/index.js";
import type { WindmillClient } from "./windmill-client.js";
import { deprecateStaleWorkflows } from "./stale-workflow-deprecator.js";
import { cleanupOrphanedWindmillFlows } from "./windmill-flow-cleanup.js";
import { fetchActiveWorkflowSlugs } from "./campaign-client.js";

type Database = typeof DbInstance;

/**
 * Re-runs the same cleanup the boot path runs once:
 *   1. Deprecate stale active workflows (>1 week old, zero runs, no active campaign).
 *   2. Delete Windmill flows of deprecated workflows no longer referenced by a campaign.
 *
 * **Rides write traffic instead of a timer.** A retention sweep only has work to
 * do when something has been written, so `maybeRun()` is called from the write
 * paths and runs the sweep at most once per `minIntervalMs`. A timer would wake
 * the Neon compute on its own schedule for a sweep that, on a quiet service, has
 * nothing to collect — and a woken compute bills for a full idle timeout.
 *
 * Both steps independently survive failures of their downstream dependencies
 * (DB hiccup, campaign-service unreachable) — one bad sweep must not wedge the
 * gate, so `lastRunAt` advances even when a step fails.
 */
export class PeriodicCleanup {
  /**
   * Boot already ran the same cleanup via `validateAndUpgradeWorkflows`, so the
   * clock starts now rather than at the epoch — otherwise the very first write
   * after every deploy would sweep again.
   */
  private lastRunAt = Date.now();
  private inFlight = false;

  constructor(
    private db: Database,
    private windmillClient: WindmillClient,
    private minIntervalMs: number,
  ) {}

  /**
   * Called from the write paths. Fire-and-forget: never blocks the request that
   * triggered it, and never runs more than once per `minIntervalMs`.
   */
  maybeRun(): void {
    if (this.inFlight) return;
    if (Date.now() - this.lastRunAt < this.minIntervalMs) return;

    this.lastRunAt = Date.now();
    this.inFlight = true;
    console.log("[workflow-service] PeriodicCleanup: sweeping (triggered by write traffic)");

    this.runOnce()
      .catch((err) => {
        console.error(
          "[workflow-service] PeriodicCleanup sweep failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  async runOnce(): Promise<void> {
    try {
      const result = await deprecateStaleWorkflows(this.db);
      if (result.deprecatedCount > 0) {
        console.log(
          `[workflow-service] PeriodicCleanup: deprecated ${result.deprecatedCount} stale workflows, kept ${result.keptByCampaign} by active campaign`,
        );
      }
      if (result.skippedNoCampaignService) {
        console.warn(
          "[workflow-service] PeriodicCleanup: stale deprecation skipped — campaign-service unreachable",
        );
      }
    } catch (err) {
      console.error(
        "[workflow-service] PeriodicCleanup: deprecateStaleWorkflows failed:",
        err instanceof Error ? err.message : err,
      );
    }

    let activeSlugs: Set<string>;
    try {
      activeSlugs = await fetchActiveWorkflowSlugs();
    } catch (err) {
      console.warn(
        "[workflow-service] PeriodicCleanup: cannot fetch active campaign slugs — skipping orphan-flow cleanup this tick:",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    try {
      const result = await cleanupOrphanedWindmillFlows(
        this.db,
        this.windmillClient,
        activeSlugs,
      );
      if (result.deleted > 0 || result.failed > 0) {
        console.log(
          `[workflow-service] PeriodicCleanup: Windmill cleanup deleted=${result.deleted} kept=${result.kept} failed=${result.failed}`,
        );
      }
    } catch (err) {
      console.error(
        "[workflow-service] PeriodicCleanup: cleanupOrphanedWindmillFlows failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * The single cleanup owned by `boot()`. Null when Windmill is not configured —
 * there are no flows to collect in that case.
 */
let sharedCleanup: PeriodicCleanup | null = null;

export function setPeriodicCleanup(cleanup: PeriodicCleanup | null): void {
  sharedCleanup = cleanup;
}

/**
 * Called when a workflow or a run is written. This is what replaces the 24h
 * timer: the sweep happens on the back of traffic the service was already
 * serving, so an idle service lets its compute sleep.
 */
export function noteWorkflowWrite(): void {
  sharedCleanup?.maybeRun();
}
