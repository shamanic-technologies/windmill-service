import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id"),
    humanId: text("human_id"),
    campaignId: text("campaign_id"),
    subrequestId: text("subrequest_id"),
    styleName: text("style_name"),
    name: text("name").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    category: text("category").notNull(),
    channel: text("channel").notNull(),
    audienceType: text("audience_type").notNull(),
    signature: text("signature").notNull(),
    signatureName: text("signature_name").notNull(),
    dag: jsonb("dag").notNull(),
    windmillFlowPath: text("windmill_flow_path"),
    windmillWorkspace: text("windmill_workspace").notNull().default("prod"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflows_org").on(table.orgId),
    index("idx_workflows_campaign").on(table.campaignId),
    uniqueIndex("idx_workflows_org_name_unique")
      .on(table.orgId, table.name),
    uniqueIndex("idx_workflows_org_signature_unique")
      .on(table.orgId, table.signature),
    uniqueIndex("idx_workflows_org_signature_name_unique")
      .on(table.orgId, table.signatureName),
    index("idx_workflows_org_style").on(table.orgId, table.styleName),
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
