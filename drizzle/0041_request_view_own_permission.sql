-- Existing databases need the new scoped request visibility permission in the
-- DB catalog, not only in the TypeScript catalog returned by the admin UI.
INSERT INTO permissions (code, name, module)
VALUES ('requests.view_own', 'Просмотр только своих заявок', 'requests')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    module = EXCLUDED.module;
--> statement-breakpoint
UPDATE permissions
SET name = 'Просмотр всех заявок'
WHERE code = 'requests.view';
--> statement-breakpoint
-- Owners receive "all" permissions by design, and admins must hold the exact
-- code they assign because role editing has anti-escalation checks.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'requests.view_own'
WHERE r.code IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
