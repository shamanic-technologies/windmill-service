import { eq, inArray } from "drizzle-orm";
import type { WindmillClient } from "./windmill-client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export class JobPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

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

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const table = this.workflowRunsTable;
      const activeRuns = await this.db
        .select()
        .from(table)
        .where(inArray(table.status, ["queued", "running"]));

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

            console.log(`[workflow-service] JobPoller: run ${run.id} → ${newStatus}`);
          } else if (run.status === "queued") {
            await this.db
              .update(table)
              .set({
                status: "running",
                startedAt: new Date(),
              })
              .where(eq(table.id, run.id));
          }
        } catch (err) {
          console.error(
            `[workflow-service] Error polling job ${run.windmillJobId}:`,
            err
          );
        }
      }
    } catch (err) {
      console.error("[workflow-service] Error fetching active runs:", err);
    } finally {
      this.isPolling = false;
    }
  }
}
