import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { workflowRuns, type Workflow, type WorkflowRun } from "../db/schema.js";
import type { db as DbInstance } from "../db/index.js";
import type { CampaignAttributionContext } from "./attribution-context.js";
import { wakeJobPoller } from "./job-poller.js";

type Database = typeof DbInstance;

export const ACTIVE_EXECUTION_STATUSES = ["dispatching", "queued", "running"];
export const EXECUTION_SCOPE_CAMPAIGN = "campaign";
export const DEFAULT_EXECUTION_CONFLICT_POLICY = "use_existing";

export type ExecutionConflictPolicy = "use_existing" | "reject";

const STALE_DISPATCHING_MS = 10 * 60 * 1000;

export function campaignExecutionKey(orgId: string, campaignId: string): string {
  return `${EXECUTION_SCOPE_CAMPAIGN}:${orgId}:${campaignId}`;
}

export function resolveExecutionConflictPolicy(
  policy: ExecutionConflictPolicy | undefined,
): ExecutionConflictPolicy {
  return policy ?? DEFAULT_EXECUTION_CONFLICT_POLICY;
}

export interface ReserveCampaignExecutionInput {
  database: Database;
  workflow: Workflow;
  orgId: string;
  userId: string;
  campaignId: string;
  brandIds: string[];
  featureSlug: string;
  inputs: Record<string, unknown> | undefined;
  attributionContext: CampaignAttributionContext | null;
  conflictPolicy: ExecutionConflictPolicy;
}

export type ReserveCampaignExecutionResult =
  | { kind: "reserved"; run: WorkflowRun; executionKey: string }
  | { kind: "conflict"; run: WorkflowRun; executionKey: string };

export async function reserveCampaignExecution(
  input: ReserveCampaignExecutionInput,
): Promise<ReserveCampaignExecutionResult> {
  const executionKey = campaignExecutionKey(input.orgId, input.campaignId);
  const staleBefore = new Date(Date.now() - STALE_DISPATCHING_MS);
  let result: ReserveCampaignExecutionResult | null = null;

  await input.database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${executionKey}))`);

    await tx
      .update(workflowRuns)
      .set({
        status: "failed",
        error: "Dispatch reservation expired before Windmill job id was recorded",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.executionKey, executionKey),
          eq(workflowRuns.status, "dispatching"),
          lt(workflowRuns.reservedAt, staleBefore),
        ),
      );

    const [existing] = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.executionKey, executionKey),
          inArray(workflowRuns.status, ACTIVE_EXECUTION_STATUSES),
        ),
      )
      .limit(1);

    if (existing) {
      result = { kind: "conflict", run: existing, executionKey };
      return;
    }

    const [run] = await tx
      .insert(workflowRuns)
      .values({
        workflowId: input.workflow.id,
        orgId: input.orgId,
        userId: input.userId,
        campaignId: input.campaignId,
        brandIds: input.brandIds.length > 0 ? input.brandIds : null,
        featureSlug: input.featureSlug,
        workflowSlug: input.workflow.workflowSlug,
        subrequestId: (input.inputs?.subrequestId as string | undefined) ?? input.workflow.subrequestId,
        windmillWorkspace: input.workflow.windmillWorkspace,
        status: "dispatching",
        inputs: input.inputs,
        executionScope: EXECUTION_SCOPE_CAMPAIGN,
        executionKey,
        conflictPolicy: input.conflictPolicy,
        attributionContext: input.attributionContext,
        reservedAt: new Date(),
      })
      .returning();

    result = { kind: "reserved", run, executionKey };
  });

  if (!result) {
    throw new Error("Failed to reserve workflow execution");
  }

  return result;
}

export async function attachRunsServiceRun(
  database: Database,
  workflowRunId: string,
  runId: string,
): Promise<WorkflowRun> {
  const [updated] = await database
    .update(workflowRuns)
    .set({ runId, dispatchStartedAt: new Date() })
    .where(eq(workflowRuns.id, workflowRunId))
    .returning();
  return updated;
}

export async function markExecutionDispatched(
  database: Database,
  workflowRunId: string,
  windmillJobId: string | null,
): Promise<WorkflowRun> {
  const [updated] = await database
    .update(workflowRuns)
    .set({
      windmillJobId,
      status: "queued",
    })
    .where(eq(workflowRuns.id, workflowRunId))
    .returning();

  // This is the only place a run becomes pollable. The poller idles itself when
  // nothing is queued or running (so an idle Neon compute can actually suspend),
  // so it has to be woken here or the run is never reconciled.
  wakeJobPoller();

  return updated;
}

export async function markExecutionDispatchFailed(
  database: Database,
  workflowRunId: string,
  error: string,
  keepReservationActive: boolean,
): Promise<WorkflowRun> {
  const [updated] = await database
    .update(workflowRuns)
    .set({
      status: keepReservationActive ? "dispatching" : "failed",
      error,
      completedAt: keepReservationActive ? null : new Date(),
    })
    .where(eq(workflowRuns.id, workflowRunId))
    .returning();
  return updated;
}
