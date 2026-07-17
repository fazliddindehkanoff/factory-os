-- FIXES.xlsx 2026-07-17, листы D/F: причины отказа/возврата по ролям.
-- Общие причины без роли («Ошибочная заявка», «Создана по ошибке / тест»)
-- остаются у всех. Лишние ролевые причины выключаем (is_active=false, обратимо),
-- недостающие добавляем. Дефолты для новых установок — в src/db/seed.ts.

-- Склад: остаётся только «Требуется уточнение по позиции».
UPDATE "rejection_reasons"
SET "is_active" = false
WHERE "role_code" = 'warehouse'
  AND "text" <> 'Требуется уточнение по позиции';--> statement-breakpoint

-- Зам. директора / главный инженер: убрать «Превышает бюджет».
UPDATE "rejection_reasons"
SET "is_active" = false
WHERE "role_code" = 'deputy_director'
  AND "text" = 'Превышает бюджет';--> statement-breakpoint

-- Зам. директора: добавить «Пересмотреть заявку», если её ещё нет.
-- Только для УЖЕ засеянных баз (иначе сид причин увидит строки и пропустит
-- остальные дефолты); свежие базы получают полный набор из seed.ts.
INSERT INTO "rejection_reasons" ("holding_id", "role_code", "text", "sort_order")
SELECT NULL, 'deputy_director', 'Пересмотреть заявку', 10
WHERE EXISTS (SELECT 1 FROM "rejection_reasons" WHERE "holding_id" IS NULL)
  AND NOT EXISTS (
  SELECT 1 FROM "rejection_reasons"
   WHERE "holding_id" IS NULL AND "role_code" = 'deputy_director' AND "text" = 'Пересмотреть заявку'
);--> statement-breakpoint

-- Руководитель снабжения: тот же список, что у зам. директора.
UPDATE "rejection_reasons"
SET "is_active" = false
WHERE "role_code" = 'procurement_head'
  AND "text" NOT IN ('Требует согласования выше', 'Обоснование недостаточно', 'Отложить на следующий период', 'Пересмотреть заявку');--> statement-breakpoint

INSERT INTO "rejection_reasons" ("holding_id", "role_code", "text", "sort_order")
SELECT NULL, 'procurement_head', v."text", v."sort_order"
FROM (VALUES
  ('Требует согласования выше', 1),
  ('Обоснование недостаточно', 2),
  ('Отложить на следующий период', 3),
  ('Пересмотреть заявку', 4)
) AS v("text", "sort_order")
WHERE EXISTS (SELECT 1 FROM "rejection_reasons" WHERE "holding_id" IS NULL)
  AND NOT EXISTS (
  SELECT 1 FROM "rejection_reasons"
   WHERE "holding_id" IS NULL AND "role_code" = 'procurement_head' AND "text" = v."text" AND "is_active" = true
);
