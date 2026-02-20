import {
  pgTable,
  uuid,
  text,
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
    appId: text("app_id"),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id"),
    campaignId: text("campaign_id"),
    subrequestId: text("subrequest_id"),
    name: text("name").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    category: text("category"),
    dag: jsonb("dag").notNull(),
    windmillFlowPath: text("windmill_flow_path"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflows_app").on(table.appId),
    index("idx_workflows_org").on(table.orgId),
    index("idx_workflows_campaign").on(table.campaignId),
    index("idx_workflows_status").on(table.status),
    uniqueIndex("idx_workflows_app_name_unique")
      .on(table.appId, table.name)
      .where(sql`status != 'deleted'`),
  ]
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").references(() => workflows.id),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id"),
    subrequestId: text("subrequest_id"),
    runId: text("run_id"),
    windmillJobId: text("windmill_job_id"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    status: text("status").notNull().default("queued"),
    inputs: jsonb("inputs"),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflow_runs_workflow").on(table.workflowId),
    index("idx_workflow_runs_windmill_job").on(table.windmillJobId),
    index("idx_workflow_runs_status").on(table.status),
    index("idx_workflow_runs_org").on(table.orgId),
  ]
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
