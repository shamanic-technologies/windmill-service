ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflows_app_name_unique" ON "workflows" ("app_id", "name") WHERE status != 'deleted';
