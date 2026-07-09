-- QA 2026-07-09, класс «фантомные права»: код объявлен в каталоге и роздан ролям,
-- но ни одна проверка на сервере его не читает — переключение в админке ничего
-- не меняет. Удаляем из каталога (и выдач), чтобы каталог не обещал
-- неисполняемых возможностей: approvals.view (видимость согласований на деле
-- определяется назначением на шаг) + остатки warehouse.reserve/warehouse.adjust
-- (из реестра убраны ещё в M5, но строки в БД пережили).
DELETE FROM "role_permissions" rp
USING "permissions" p
WHERE rp."permission_id" = p."id"
  AND p."code" IN ('approvals.view', 'warehouse.reserve', 'warehouse.adjust');
--> statement-breakpoint
DELETE FROM "permissions"
WHERE "code" IN ('approvals.view', 'warehouse.reserve', 'warehouse.adjust');
