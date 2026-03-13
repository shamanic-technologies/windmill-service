-- Add brand_id and workflow_name to workflow_runs for tracking
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "brand_id" text;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "workflow_name" text;
