ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY ctid) - 1 AS rn
  FROM "request_items"
)
UPDATE "request_items"
SET "sort_order" = ranked.rn
FROM ranked
WHERE "request_items"."id" = ranked.id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_items_request_sort_idx" ON "request_items" ("request_id", "sort_order");
