-- The request schema calls category/channel/audienceType optional; migration 0007 made the
-- columns NOT NULL. Omitting one therefore passed validation and died in the database, and the
-- caller saw a generic 500. Drizzle's own schema has always declared these three nullable, so
-- the database was the odd one out. They are provenance tags — nothing branches on them — so
-- "not stated" is a legitimate value and the schema keeps its word.
ALTER TABLE "workflows" ALTER COLUMN "category" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "channel" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "audience_type" DROP NOT NULL;
