-- №14: право «Сводка "Заявки по статусам"» — каталог + выдача всем системным
-- ролям, кроме заявителя. Кастомные роли холдингов не трогаем (админ раздаёт сам).
INSERT INTO "permissions" ("code", "name", "module")
VALUES ('reports.status_summary', 'Сводка «Заявки по статусам»', 'reports')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'reports.status_summary'
WHERE r."holding_id" IS NULL AND r."code" <> 'requester'
ON CONFLICT DO NOTHING;
