-- Drop parent_run_id from workflow_runs.
-- Parent-child run relationships are tracked in runs-service, not here.
ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "parent_run_id";
