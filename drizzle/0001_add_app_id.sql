ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "app_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_app" ON "workflows" USING btree ("app_id");
