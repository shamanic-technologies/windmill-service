import { eq, inArray } from "drizzle-orm";
import { isUnresolvableWindmillJobError, type WindmillClient } from "./windmill-client.js";
import { closeRun } from "./runs-client.js";
import { traceEvent } from "./trace-event.js";
import { attributionContextToHeaders } from "./attribution-context.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Polls Windmill for the outcome of dispatched jobs.
 *
 * The poller **stops itself once no run is queued or running**, and is woken by
 * `wakeJobPoller()` when a run is dispatched. An unconditional `SELECT` every
 * 10s would hold the Neon compute open forever, which defeats scale-to-zero:
 * the compute never reaches its idle timeout, so the whole billing period is
 * charged as active even when nothing has executed.
 */
/**
 * How many CONSECUTIVE polls must see the same permanently-unresolvable answer
 * from Windmill before the run is failed. One is enough to be right and not
 * enough to be safe: the counter is what keeps a freak 404 during a Windmill
 * restart from killing a live run.
 */
export const UNRESOLVABLE_JOB_POLL_ATTEMPTS = 3;

export class JobPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  /**
   * Set by `wake()`. Cleared at the top of `poll()`, i.e. BEFORE the query, so
   * a run dispatched while a poll is in flight always keeps the poller alive —
   * without it, a wake landing between the query and the idle check would be
   * swallowed and the run would never be reconciled.
   */
  private wokenDuringPoll = false;

  /**
   * Consecutive polls, per run, that got a permanently-unresolvable answer for
   * the run's Windmill job. Reset by any poll that resolves the job or fails
   * transiently, so only an uninterrupted streak terminates a run. In-memory on
   * purpose: a restart simply re-observes the streak within ~30s, and there is
   * nothing worth persisting about a counter that only ever counts to three.
   */
  private unresolvablePolls = new Map<string, number>();

  constructor(
    private db: any,
    private windmillClient: WindmillClient,
    private workflowRunsTable: any,
    private pollIntervalMs = 10_000
  ) {}

  start(): void {
    if (this.intervalId) return;
    console.log(`[workflow-service] JobPoller starting (every ${this.pollIntervalMs}ms)`);
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[workflow-service] JobPoller stopped");
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /** A run was just dispatched — there is work to reconcile. */
  wake(): void {
    this.wokenDuringPoll = true;
    if (!this.intervalId) {
      console.log("[workflow-service] JobPoller woken by a dispatched run");
    }
    this.start();
  }

  /**
   * Terminate a run whose Windmill job Windmill itself can no longer resolve.
   *
   * A run left `queued` holds its `execution_key`, and `conflict_policy:
   * "use_existing"` then dedups every later execute for that campaign onto the
   * zombie — so one dead job silently disables a whole campaign forever. The
   * run is failed (never `completed`: it did not complete) and the error says
   * exactly what happened, which is what frees the key.
   */
  private async failUnresolvableRun(run: any, err: unknown): Promise<void> {
    const table = this.workflowRunsTable;
    const detail = err instanceof Error ? err.message : String(err);
    const message =
      `Windmill job ${run.windmillJobId} became unresolvable and will never report an outcome ` +
      `(most often because the workflow was upgraded while the job was in flight, deleting the flow ` +
      `nodes it referenced). Failing the run after ${UNRESOLVABLE_JOB_POLL_ATTEMPTS} consecutive ` +
      `unresolvable polls so it stops holding its execution key. Windmill said: ${detail}`;

    console.error(`[workflow-service] JobPoller: FAILING run ${run.id} — ${message}`);

    try {
      await this.db
        .update(table)
        .set({ status: "failed", result: null, error: message, completedAt: new Date() })
        .where(eq(table.id, run.id));
    } catch (updateErr) {
      console.error(
        `[workflow-service] JobPoller: failed to mark run ${run.id} as failed:`,
        updateErr,
      );
      return;
    }

    if (run.runId && run.orgId) {
      try {
        await closeRun(run.runId, "failed", run.orgId);
      } catch (closeErr) {
        console.error(
          `[workflow-service] JobPoller: failed to close run ${run.runId} in runs-service:`,
          closeErr,
        );
      }
    }

    if (run.runId) {
      const pollerHeaders: Record<string, string> = {};
      if (run.orgId) pollerHeaders["x-org-id"] = run.orgId;
      if (run.userId) pollerHeaders["x-user-id"] = run.userId;
      if (run.workflowSlug) pollerHeaders["x-workflow-slug"] = run.workflowSlug;
      if (run.featureSlug) pollerHeaders["x-feature-slug"] = run.featureSlug;
      if (run.campaignId) pollerHeaders["x-campaign-id"] = run.campaignId;
      Object.assign(pollerHeaders, attributionContextToHeaders(run.attributionContext));

      traceEvent(run.runId, {
        service: "workflow-service",
        event: "job-unresolvable",
        detail: message,
        level: "error",
        data: {
          windmillJobId: run.windmillJobId,
          workflowSlug: run.workflowSlug,
          status: "failed",
          reason: "windmill-job-unresolvable",
        },
      }, pollerHeaders).catch(() => {});
    }
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    this.wokenDuringPoll = false;

    try {
      const table = this.workflowRunsTable;
      const activeRuns = await this.db
        .select()
        .from(table)
        .where(inArray(table.status, ["queued", "running"]));

      if (activeRuns.length === 0 && !this.wokenDuringPoll) {
        console.log(
          "[workflow-service] JobPoller: no queued or running runs — idling until the next dispatch",
        );
        this.stop();
        return;
      }

      for (const run of activeRuns) {
        if (!run.windmillJobId) continue;

        try {
          const job = await this.windmillClient.getJob(run.windmillJobId);

          if (!job.running) {
            const success = job.success ?? false;
            const newStatus = success ? "completed" : "failed";

            await this.db
              .update(table)
              .set({
                status: newStatus,
                result: success ? job.result : null,
                error: success ? null : (typeof job.result === "string" ? job.result : JSON.stringify(job.result ?? "Unknown error")),
                completedAt: new Date(),
              })
              .where(eq(table.id, run.id));

            // Close the run in runs-service
            if (run.runId && run.orgId) {
              try {
                await closeRun(run.runId, newStatus, run.orgId);
              } catch (err) {
                console.error(`[workflow-service] JobPoller: failed to close run ${run.runId} in runs-service:`, err);
              }
            }

            console.log(`[workflow-service] JobPoller: run ${run.id} → ${newStatus}`);

            if (run.runId) {
              const pollerHeaders: Record<string, string> = {};
              if (run.orgId) pollerHeaders["x-org-id"] = run.orgId;
              if (run.userId) pollerHeaders["x-user-id"] = run.userId;
              if (run.workflowSlug) pollerHeaders["x-workflow-slug"] = run.workflowSlug;
              if (run.featureSlug) pollerHeaders["x-feature-slug"] = run.featureSlug;
              if (run.campaignId) pollerHeaders["x-campaign-id"] = run.campaignId;
              Object.assign(pollerHeaders, attributionContextToHeaders(run.attributionContext));

              traceEvent(run.runId, {
                service: "workflow-service",
                event: "job-completed",
                detail: `Windmill job ${run.windmillJobId} finished: status=${newStatus} workflowSlug="${run.workflowSlug ?? "unknown"}"`,
                level: success ? "info" : "error",
                data: { windmillJobId: run.windmillJobId, workflowSlug: run.workflowSlug, status: newStatus },
              }, pollerHeaders).catch(() => {});
            }
          } else if (run.status === "queued") {
            await this.db
              .update(table)
              .set({
                status: "running",
                startedAt: new Date(),
              })
              .where(eq(table.id, run.id));
          }
          this.unresolvablePolls.delete(run.id);
        } catch (err) {
          if (isUnresolvableWindmillJobError(err)) {
            const seen = (this.unresolvablePolls.get(run.id) ?? 0) + 1;
            this.unresolvablePolls.set(run.id, seen);
            console.error(
              `[workflow-service] JobPoller: Windmill cannot resolve job ${run.windmillJobId} for run ${run.id} (${seen}/${UNRESOLVABLE_JOB_POLL_ATTEMPTS}):`,
              err,
            );
            if (seen >= UNRESOLVABLE_JOB_POLL_ATTEMPTS) {
              this.unresolvablePolls.delete(run.id);
              await this.failUnresolvableRun(run, err);
            }
          } else {
            this.unresolvablePolls.delete(run.id);
            console.error(
              `[workflow-service] Error polling job ${run.windmillJobId}:`,
              err
            );
          }
        }
      }

      // Drop counters for runs that are no longer active, so the map cannot
      // grow with ids nothing will ever poll again.
      if (this.unresolvablePolls.size > 0) {
        const activeIds = new Set(activeRuns.map((r: any) => r.id));
        for (const id of [...this.unresolvablePolls.keys()]) {
          if (!activeIds.has(id)) this.unresolvablePolls.delete(id);
        }
      }
    } catch (err) {
      console.error("[workflow-service] Error fetching active runs:", err);
    } finally {
      this.isPolling = false;
    }
  }
}

/**
 * The single poller owned by `boot()`. Null when Windmill is not configured —
 * nothing is dispatched in that case, so there is nothing to wake.
 */
let sharedPoller: JobPoller | null = null;

export function setJobPoller(poller: JobPoller | null): void {
  sharedPoller = poller;
}

export function getJobPoller(): JobPoller | null {
  return sharedPoller;
}

/**
 * Called when a run is dispatched to Windmill. The poller idles itself once no
 * run is outstanding, so this is what brings it back.
 */
export function wakeJobPoller(): void {
  sharedPoller?.wake();
}
