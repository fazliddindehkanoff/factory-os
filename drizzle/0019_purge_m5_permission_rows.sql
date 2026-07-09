-- Дочистка класса «фантомные права» (продолжение 0018): пять кодов, удалённых
-- из каталога ещё в M5, но чьи строки (и выдачи ролям) пережили в БД прода.
-- Ни один из кодов не проверяется в коде — удаление ничего не меняет в правах.
DELETE FROM "role_permissions" rp
USING "permissions" p
WHERE rp."permission_id" = p."id"
  AND p."code" IN ('audit.export', 'finance.approve_payment', 'procurement.manage', 'requests.comment', 'settings.view');
--> statement-breakpoint
DELETE FROM "permissions"
WHERE "code" IN ('audit.export', 'finance.approve_payment', 'procurement.manage', 'requests.comment', 'settings.view');
