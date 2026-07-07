ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "workflow_dynasty_status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workflow_dynasty_status_check" CHECK ("workflow_dynasty_status" IN ('active', 'deprecated'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
