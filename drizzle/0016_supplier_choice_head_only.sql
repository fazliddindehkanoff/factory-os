-- Выбор поставщика — только у руководителя снабжения (решение владельца
-- 2026-07-06): у системных ролей «Снабжение» и «Менеджер по снабжению»
-- отзывается procurement.select_supplier. Кастомные роли холдингов не трогаем.
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND r."holding_id" IS NULL
  AND r."code" IN ('procurement', 'procurement_manager')
  AND p."code" = 'procurement.select_supplier';
