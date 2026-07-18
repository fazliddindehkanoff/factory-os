-- Final user-facing names for existing installations. Update every role with the
-- stable legacy code, including holding-scoped clones created by administrators.
UPDATE "roles"
SET "name" = 'Главный инженер'
WHERE "code" = 'deputy_director'
  AND "name" IS DISTINCT FROM 'Главный инженер';--> statement-breakpoint

UPDATE "workflow_steps" ws
SET "step_name" = 'Главный инженер'
FROM "roles" r
WHERE r."id" = ws."approver_role_id"
  AND r."code" = 'deputy_director'
  AND ws."step_kind" = 'approval'
  AND ws."step_name" IS DISTINCT FROM 'Главный инженер';--> statement-breakpoint

UPDATE "workflow_steps"
SET "step_name" = 'Снабженец — процесс поиска'
WHERE "step_kind" = 'procurement'
  AND "step_name" IS DISTINCT FROM 'Снабженец — процесс поиска';
