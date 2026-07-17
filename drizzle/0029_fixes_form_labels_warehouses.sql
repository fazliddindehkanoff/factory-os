-- FIXES.xlsx 2026-07-17, группа A: тексты формы создания заявки + склады.
-- Бэкофилл для уже засеянных холдингов (seed-form-fields идемпотентен и повторно
-- форму не трогает); дефолты для новых холдингов обновлены в src/db/seed-form-fields.ts.

-- 1) Тип заявки: убрать вариант «Ремонт» (repair_request).
UPDATE "form_fields"
SET "options" = COALESCE(
      (SELECT jsonb_agg(o) FROM jsonb_array_elements("options") o WHERE o->>'value' <> 'repair_request'),
      '[]'::jsonb)
WHERE "screen" = 'request_create'
  AND "field_key" = 'requestType'
  AND "options" IS NOT NULL;--> statement-breakpoint

-- 2) Объект: реальные объекты вместо примеров «Объект №1 / №2».
--    Трогаем только нетронутый дефолт, чтобы не затереть настройку админа.
UPDATE "form_fields"
SET "options" = '[{"value":"Zelal Tekstil","label":"Zelal Tekstil"},{"value":"Zarbdor","label":"Zarbdor"}]'::jsonb
WHERE "screen" = 'request_create'
  AND "field_key" = 'obyekt'
  AND "options" @> '[{"value":"Объект №1"}]'::jsonb;--> statement-breakpoint

-- 3) Позиция: заголовок секции «Спецификация заявки», подпись поля названия.
UPDATE "form_fields"
SET "label" = 'Спецификация заявки',
    "placeholder" = 'Наименование материала или услуги'
WHERE "screen" = 'request_create'
  AND "field_key" = 'itemName';--> statement-breakpoint

-- 4) Код товара: подпись вместо примера.
UPDATE "form_fields"
SET "placeholder" = 'КОД товара'
WHERE "screen" = 'request_create'
  AND "field_key" = 'itemCode';--> statement-breakpoint

-- 5) Примечание: короткая подпись вместо длинного примера.
UPDATE "form_fields"
SET "placeholder" = 'Примечания'
WHERE "screen" = 'request_create'
  AND "field_key" = 'note';--> statement-breakpoint

-- 6) Вложение: полная подпись.
UPDATE "form_fields"
SET "label" = 'Вложение файла или изображения'
WHERE "screen" = 'request_create'
  AND "field_key" = 'attachment';--> statement-breakpoint

-- 7) Склады назначения: ровно четыре склада холдинга.
--    Недостающие создаём (в первом по дате заводе холдинга), лишние активные —
--    деактивируем (soft-delete, как делает админка; остатки/движения сохраняются).
INSERT INTO "warehouses" ("holding_id", "factory_id", "name")
SELECT h."id",
       (SELECT f."id" FROM "factories" f
         WHERE f."holding_id" = h."id" AND f."status" <> 'inactive'
         ORDER BY f."created_at" LIMIT 1),
       w."name"
FROM "holdings" h
CROSS JOIN (VALUES ('Главный склад'), ('Склад запчастей'), ('Склад вязального цеха'), ('Склад ниток')) AS w("name")
WHERE NOT EXISTS (
  SELECT 1 FROM "warehouses" x
   WHERE x."holding_id" = h."id" AND x."name" = w."name" AND x."status" <> 'inactive'
);--> statement-breakpoint

UPDATE "warehouses"
SET "status" = 'inactive'
WHERE "status" = 'active'
  AND "name" NOT IN ('Главный склад', 'Склад запчастей', 'Склад вязального цеха', 'Склад ниток');
