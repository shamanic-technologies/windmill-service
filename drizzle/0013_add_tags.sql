ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb;
