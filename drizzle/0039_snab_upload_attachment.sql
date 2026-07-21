-- FIXES 2026-07-20 (тест): КП прикладывает снабженец, но право
-- requests.upload_attachment было только у автора заявки — закупочные роли не
-- могли прикрепить файл КП. Выдаём право снабжению (менеджер и руководитель) во
-- всех существующих холдингах; дефолт новых установок — src/rbac/system-roles.ts.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'requests.upload_attachment'
WHERE r.code IN ('procurement', 'procurement_head', 'procurement_manager')
ON CONFLICT DO NOTHING;
