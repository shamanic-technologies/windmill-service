ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "channel" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "audience_type" text;
