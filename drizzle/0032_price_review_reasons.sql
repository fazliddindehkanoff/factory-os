-- FIXES.xlsx 2026-07-17, лист G: причины действия «Пересмотреть цену»
-- (псевдо-роль price_review; в общие ролевые списки не попадает —
-- endpoint отдаёт их только для action=return_research).
-- Только для УЖЕ засеянных баз — свежие получают набор из seed.ts (иначе сид
-- увидит строки и пропустит остальные дефолты).
INSERT INTO "rejection_reasons" ("holding_id", "role_code", "text", "sort_order")
SELECT NULL, 'price_review', v."text", v."sort_order"
FROM (VALUES
  ('Завышенная цена', 1),
  ('Найти других поставщиков', 2),
  ('Найти на перечисление', 3),
  ('Сделать конкурентный лист', 4)
) AS v("text", "sort_order")
WHERE EXISTS (SELECT 1 FROM "rejection_reasons" WHERE "holding_id" IS NULL)
  AND NOT EXISTS (
  SELECT 1 FROM "rejection_reasons"
   WHERE "holding_id" IS NULL AND "role_code" = 'price_review' AND "text" = v."text"
);
