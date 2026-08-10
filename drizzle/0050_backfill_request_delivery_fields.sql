-- Older mobile requests kept warehouse/date only in each item description.
-- Promote them to the canonical request fields used by desktop details.
UPDATE "requests" r
SET "warehouse_name" = (
  SELECT trim((regexp_match(ri."description", E'Склад назначения: ([^\\r\\n]+)'))[1])
  FROM "request_items" ri
  WHERE ri."request_id" = r."id"
    AND ri."description" ~ 'Склад назначения:'
  ORDER BY ri."sort_order", ri."id"
  LIMIT 1
)
WHERE r."warehouse_name" IS NULL
  AND EXISTS (
    SELECT 1 FROM "request_items" ri
    WHERE ri."request_id" = r."id" AND ri."description" ~ 'Склад назначения:'
  );--> statement-breakpoint

UPDATE "requests" r
SET "needed_date" = (
  SELECT min(((regexp_match(ri."description", 'Необходимо к дате: ([0-9]{4}-[0-9]{2}-[0-9]{2})'))[1])::date)::timestamp
         AT TIME ZONE 'Asia/Tashkent'
  FROM "request_items" ri
  WHERE ri."request_id" = r."id"
    AND ri."description" ~ 'Необходимо к дате:'
)
WHERE r."needed_date" IS NULL
  AND EXISTS (
    SELECT 1 FROM "request_items" ri
    WHERE ri."request_id" = r."id" AND ri."description" ~ 'Необходимо к дате:'
  );--> statement-breakpoint

UPDATE "requests" r
SET "warehouse_id" = w."id"
FROM "warehouses" w
WHERE r."warehouse_id" IS NULL
  AND r."warehouse_name" IS NOT NULL
  AND r."holding_id" = w."holding_id"
  AND w."status" = 'active'
  AND lower(trim(r."warehouse_name")) IN (
    lower(trim(w."name")),
    lower(trim(coalesce(w."name_uz", ''))),
    lower(trim(coalesce(w."name_tr", '')))
  );
