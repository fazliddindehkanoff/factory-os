-- Поле «Объект» на форме создания заявки: настраиваемый select, значения задаёт
-- админ в конструкторе формы. Для новых холдингов сеется в seed-form-fields;
-- здесь — бэкофилл для уже существующих холдингов (флаг form_seeded у них уже
-- стоит, обычный сев их не тронет). Идемпотентно: NOT EXISTS + уникальный ключ.
INSERT INTO "form_fields"
  ("holding_id", "screen", "field_key", "label", "field_type", "system", "required", "enabled", "options", "step_group", "order_index")
SELECT h."id", 'request_create', 'obyekt', 'Объект', 'select', false, false, true,
       '[{"value":"Объект №1","label":"Объект №1"},{"value":"Объект №2","label":"Объект №2"}]'::jsonb,
       1, 4
FROM "holdings" h
WHERE NOT EXISTS (
  SELECT 1 FROM "form_fields" ff
  WHERE ff."holding_id" = h."id"
    AND ff."screen" = 'request_create'
    AND ff."field_key" = 'obyekt'
);
