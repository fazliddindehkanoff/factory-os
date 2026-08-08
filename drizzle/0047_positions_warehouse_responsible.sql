CREATE TABLE IF NOT EXISTS "positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id"),
  "name_ru" text NOT NULL,
  "name_uz" text NOT NULL,
  "name_tr" text NOT NULL,
  "order_index" integer DEFAULT 0 NOT NULL,
  "status" "entity_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_holding_idx" ON "positions" ("holding_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "positions_holding_name_ru_idx" ON "positions" ("holding_id", lower("name_ru")) WHERE "status" <> 'archived';--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "position_id" uuid REFERENCES "positions"("id");--> statement-breakpoint

INSERT INTO "positions" ("holding_id", "name_ru", "name_uz", "name_tr", "order_index")
SELECT u."holding_id", trim(u."position"), trim(u."position"), trim(u."position"),
       row_number() OVER (PARTITION BY u."holding_id" ORDER BY lower(trim(u."position"))) - 1
FROM "users" u
WHERE u."holding_id" IS NOT NULL AND nullif(trim(u."position"), '') IS NOT NULL
GROUP BY u."holding_id", trim(u."position")
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "users" u SET "position_id" = p."id"
FROM "positions" p
WHERE u."position_id" IS NULL AND u."holding_id" = p."holding_id"
  AND lower(trim(u."position")) = lower(trim(p."name_ru"));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "warehouse_responsibles" (
  "warehouse_id" uuid PRIMARY KEY REFERENCES "warehouses"("id") ON DELETE CASCADE,
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_responsibles_holding_idx" ON "warehouse_responsibles" ("holding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_responsibles_user_idx" ON "warehouse_responsibles" ("user_id");--> statement-breakpoint

ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "warehouse_id" uuid REFERENCES "warehouses"("id");--> statement-breakpoint
UPDATE "requests" r SET "warehouse_id" = w."id"
FROM "warehouses" w
WHERE r."warehouse_id" IS NULL AND r."holding_id" = w."holding_id"
  AND lower(trim(r."warehouse_name")) IN (lower(trim(w."name")), lower(trim(coalesce(w."name_uz", ''))), lower(trim(coalesce(w."name_tr", ''))));--> statement-breakpoint

INSERT INTO "unit_types" ("holding_id", "code", "name_ru", "name_uz", "name_tr", "order_index")
SELECT h."id", v.code, v.ru, v.uz, v.tr, v.ord
FROM "holdings" h
CROSS JOIN (VALUES
  ('pcs', 'Штука', 'Dona', 'Adet', 0),
  ('kg', 'Килограмм', 'Kilogramm', 'Kilogram', 1),
  ('g', 'Грамм', 'Gramm', 'Gram', 2),
  ('l', 'Литр', 'Litr', 'Litre', 3),
  ('ml', 'Миллилитр', 'Millilitr', 'Mililitre', 4),
  ('m', 'Метр', 'Metr', 'Metre', 5),
  ('cm', 'Сантиметр', 'Santimetr', 'Santimetre', 6),
  ('m2', 'Квадратный метр', 'Kvadrat metr', 'Metrekare', 7),
  ('m3', 'Кубический метр', 'Kub metr', 'Metreküp', 8),
  ('pack', 'Упаковка', 'Qadoq', 'Paket', 9),
  ('set', 'Комплект', 'To‘plam', 'Takım', 10),
  ('roll', 'Рулон', 'Rulon', 'Rulo', 11),
  ('box', 'Коробка', 'Quti', 'Kutu', 12)
) AS v(code, ru, uz, tr, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM "unit_types" u WHERE u."holding_id" = h."id" AND lower(u."code") = lower(v.code)
);--> statement-breakpoint
