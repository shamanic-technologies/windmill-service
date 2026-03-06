-- Add status column for workflow lifecycle (active / deprecated)
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
-- Track upgrade chain: deprecated workflow points to its replacement
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "upgraded_to" uuid;
--> statement-breakpoint
-- Tracking: which user created this workflow
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
-- Tracking: which run created this workflow
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "created_by_run_id" text;
--> statement-breakpoint
-- Drop old org-scoped unique indexes (workflows are public, not org-scoped)
DROP INDEX IF EXISTS "idx_workflows_org_name_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_org_signature_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflows_org_signature_name_unique";
--> statement-breakpoint
-- Recreate as global partial unique indexes — only active workflows must be unique
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_name_active" ON "workflows" ("name") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_signature_active" ON "workflows" ("signature") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_signature_name_active" ON "workflows" ("signature_name") WHERE "status" = 'active';
