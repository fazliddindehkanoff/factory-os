-- Чат «Снабжение» 20.06: поле «местный или импорт» в форме заявки.
-- Сид формы идемпотентен и не трогает уже настроенные холдинги, поэтому
-- существующим добавляем поле миграцией (в конец шага 1, если его ещё нет).
INSERT INTO "form_fields" ("holding_id", "screen", "field_key", "label", "field_type", "system", "required", "enabled", "options", "step_group", "order_index")
SELECT h."holding_id", 'request_create', 'origin', 'Происхождение', 'select', false, false, true,
       '[{"value":"local","label":"Местный"},{"value":"import","label":"Импорт"}]'::jsonb, 1,
       (SELECT COALESCE(MAX("order_index"), 0) + 1
          FROM "form_fields" f2
         WHERE f2."holding_id" = h."holding_id" AND f2."screen" = 'request_create' AND f2."step_group" = 1)
FROM (SELECT DISTINCT "holding_id" FROM "form_fields" WHERE "screen" = 'request_create') h
WHERE NOT EXISTS (
  SELECT 1 FROM "form_fields" f3
   WHERE f3."holding_id" = h."holding_id" AND f3."screen" = 'request_create' AND f3."field_key" = 'origin'
);
