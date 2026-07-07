import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    createdForBrandId: text("created_for_brand_id"),
    humanId: text("human_id"),
    campaignId: text("campaign_id"),
    subrequestId: text("subrequest_id"),
    workflowSlug: text("workflow_slug").notNull(),
    workflowName: text("workflow_name").notNull(),
    workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
    workflowDynastyName: text("workflow_dynasty_name").notNull(),
    description: text("description"),
    featureSlug: text("feature_slug").notNull(),
    category: text("category"),
    channel: text("channel"),
    audienceType: text("audience_type"),
    signature: text("signature").notNull(),
    workflowDynastySignatureName: text("workflow_dynasty_signature_name").notNull(),
    version: integer("version").notNull().default(1),
    dag: jsonb("dag").notNull(),
    tags: jsonb("tags").default([]),
    status: text("status").notNull().default("active"),
    // Dynasty-level status, independent of the per-version `status` above. Marks
    // an entire lineage active/deprecated on demand (staff action). All rows
    // sharing a workflow_dynasty_slug carry the same value.
    workflowDynastyStatus: text("workflow_dynasty_status").notNull().default("active"),
    creationType: text("creation_type").notNull().default("scratch"),
    createdFromWorkflow: uuid("created_from_workflow"),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: text("created_by_run_id"),
    windmillFlowPath: text("windmill_flow_path"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_workflows_workflow_slug_unique").on(table.workflowSlug),
    index("idx_workflows_dynasty_slug").on(table.workflowDynastySlug),
    index("idx_workflows_feature_signature").on(table.featureSlug, table.workflowDynastySignatureName),
  ]
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").references(() => workflows.id),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    subrequestId: text("subrequest_id"),
    runId: text("run_id"),

    windmillJobId: text("windmill_job_id"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    status: text("status").notNull().default("queued"),
    executionScope: text("execution_scope"),
    executionKey: text("execution_key"),
    conflictPolicy: text("conflict_policy"),
    attributionContext: jsonb("attribution_context"),
    inputs: jsonb("inputs"),
    result: jsonb("result"),
    error: text("error"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflow_runs_workflow").on(table.workflowId),
    index("idx_workflow_runs_status").on(table.status),
    index("idx_workflow_runs_execution_key").on(table.executionKey),
    uniqueIndex("idx_workflow_runs_active_execution_key_unique")
      .on(table.executionKey)
      .where(sql`execution_key IS NOT NULL AND status IN ('dispatching', 'queued', 'running')`),
  ]
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
