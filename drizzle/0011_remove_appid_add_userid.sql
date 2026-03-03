-- Remove app_id from workflows, replace appId-based indexes with orgId-based
-- Add user_id and parent_run_id to workflow_runs

-- Drop appId-based indexes
DROP INDEX IF EXISTS "idx_workflows_app";
DROP INDEX IF EXISTS "idx_workflows_app_name_unique";
DROP INDEX IF EXISTS "idx_workflows_app_signature_unique";
DROP INDEX IF EXISTS "idx_workflows_app_signature_name_unique";
DROP INDEX IF EXISTS "idx_workflows_style";

-- Drop app_id column
ALTER TABLE "workflows" DROP COLUMN IF EXISTS "app_id";

-- Add orgId-based replacement indexes
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_org_name_unique" ON "workflows" ("org_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_org_signature_unique" ON "workflows" ("org_id", "signature");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_org_signature_name_unique" ON "workflows" ("org_id", "signature_name");
CREATE INDEX IF NOT EXISTS "idx_workflows_org_style" ON "workflows" ("org_id", "style_name");

-- Add user_id and parent_run_id to workflow_runs
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "parent_run_id" text;
