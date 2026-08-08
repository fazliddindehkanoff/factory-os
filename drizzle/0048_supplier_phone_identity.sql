ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "normalized_phone" text;--> statement-breakpoint
UPDATE "suppliers"
SET "normalized_phone" = CASE
  WHEN length(regexp_replace(coalesce("phone", ''), '\D', '', 'g')) = 9
    THEN '998' || regexp_replace("phone", '\D', '', 'g')
  WHEN length(regexp_replace(coalesce("phone", ''), '\D', '', 'g')) = 10
    AND regexp_replace("phone", '\D', '', 'g') LIKE '0%'
    THEN '998' || substr(regexp_replace("phone", '\D', '', 'g'), 2)
  ELSE nullif(regexp_replace(coalesce("phone", ''), '\D', '', 'g'), '')
END
WHERE "normalized_phone" IS NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "holding_id", "normalized_phone"
    ORDER BY CASE WHEN "status" = 'active' THEN 0 ELSE 1 END, "created_at", "id"
  ) AS rn
  FROM "suppliers"
  WHERE "normalized_phone" IS NOT NULL
)
UPDATE "suppliers" s SET "normalized_phone" = NULL
FROM ranked r WHERE s."id" = r."id" AND r.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_holding_normalized_phone_idx"
ON "suppliers" ("holding_id", "normalized_phone");
