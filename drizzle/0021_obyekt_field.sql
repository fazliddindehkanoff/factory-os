-- Поле «Объект» на форме создания заявки: настраиваемый select, значения задаёт
-- админ в конструкторе формы. Для новых холдингов сеется в seed-form-fields;
-- здесь — бэкофилл для уже существующих (сид идемпотентен и не трогает
-- настроенные холдинги). Ставим в конец шага 1, если поля ещё нет.
INSERT INTO "form_fields" ("holding_id", "screen", "field_key", "label", "field_type", "system", "required", "enabled", "options", "step_group", "order_index")
SELECT h."holding_id", 'request_create', 'obyekt', 'Объект', 'select', false, false, true,
       '[{"value":"Объект №1","label":"Объект №1"},{"value":"Объект №2","label":"Объект №2"}]'::jsonb, 1,
       (SELECT COALESCE(MAX("order_index"), 0) + 1
          FROM "form_fields" f2
         WHERE f2."holding_id" = h."holding_id" AND f2."screen" = 'request_create' AND f2."step_group" = 1)
FROM (SELECT DISTINCT "holding_id" FROM "form_fields" WHERE "screen" = 'request_create') h
WHERE NOT EXISTS (
  SELECT 1 FROM "form_fields" f3
   WHERE f3."holding_id" = h."holding_id" AND f3."screen" = 'request_create' AND f3."field_key" = 'obyekt'
);
