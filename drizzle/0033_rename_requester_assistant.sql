-- FIXES 2026-07-17: роль «Заявитель» переименована в «Assistant».
-- Имя роли берётся из roles.name (его показывает бейдж роли и /me), поэтому
-- переименовываем существующие записи; дефолт для новых установок — в
-- src/rbac/system-roles.ts. Латиница «Assistant» одинакова во всех языках
-- (DOM-переводчик её не трогает).
UPDATE "roles"
SET "name" = 'Assistant'
WHERE "code" = 'requester'
  AND "name" = 'Заявитель';
