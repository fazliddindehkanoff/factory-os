UPDATE "workflow_steps" ws
SET "approver_role_id" = roles.id
FROM "roles" roles
WHERE ws."step_kind" = 'price_approval'
  AND ws."step_name" = 'Снабжение — менеджер'
  AND roles."code" = 'procurement_head'
  AND roles."holding_id" IS NULL;
