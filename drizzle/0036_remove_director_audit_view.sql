-- FIXES 2026-07-19: у роли «Директор» убирается право audit.view.
-- Директор больше не видит «Историю действий» на карточке заявки. То же право
-- было единственным источником сквозной видимости (TOP_VIEW_PERMS в
-- request-visibility.ts), поэтому директор теперь видит заявки только по участию
-- (автор / ответственный / шаг маршрута / уже действовал). Суммы остаются видны
-- через finance.view. Дефолт для новых установок — в src/rbac/system-roles.ts.
-- Удаляем связку audit.view у ВСЕХ ролей с кодом 'director' (системная роль с
-- holding_id = null и её холдинговые клоны).
DELETE FROM "role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'director')
  AND "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'audit.view');
