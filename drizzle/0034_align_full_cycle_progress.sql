-- Align the user-facing full-cycle progress with the approved 10-stage preview.
-- The stable deputy_director code is retained so existing assignments keep working;
-- only its visible business name changes to «Главный инженер».
UPDATE "roles"
SET "name" = 'Главный инженер'
WHERE "holding_id" IS NULL
  AND "code" = 'deputy_director';--> statement-breakpoint

-- Use consistent stage names across existing workflows. Step kinds and role
-- assignments are unchanged, so active requests keep their current step IDs.
UPDATE "workflow_steps" ws
SET "step_name" = CASE
  WHEN ws."step_kind" = 'approval' AND r."code" = 'dept_head'
    THEN 'Руководитель отдела'
  WHEN ws."step_kind" = 'warehouse_check'
    THEN 'Проверка склада'
  WHEN ws."step_kind" = 'approval' AND r."code" = 'deputy_director'
    THEN 'Главный инженер'
  WHEN ws."step_kind" = 'procurement_intake'
    THEN 'Руководитель снабжения — принятие заявки'
  WHEN ws."step_kind" = 'procurement'
    THEN 'Снабженец — поиск поставщика'
  WHEN ws."step_kind" = 'price_approval'
    THEN 'Руководитель снабжения — проверка цены'
  WHEN ws."step_kind" = 'approval' AND r."code" = 'director'
    THEN 'Директор'
  WHEN ws."step_kind" = 'ordering'
    THEN 'Снабженец — оформление заказа'
  WHEN ws."step_kind" = 'receiving'
    THEN 'Склад — приёмка'
  ELSE ws."step_name"
END
FROM "roles" r
WHERE r."id" = ws."approver_role_id"
  AND (
    (ws."step_kind" = 'approval' AND r."code" IN ('dept_head', 'deputy_director', 'director'))
    OR ws."step_kind" IN ('warehouse_check', 'procurement_intake', 'procurement', 'price_approval', 'ordering', 'receiving')
  );--> statement-breakpoint

-- The executive-director approval is explicitly outside the approved chain.
UPDATE "workflow_steps" ws
SET "enabled" = false
FROM "roles" r
WHERE r."id" = ws."approver_role_id"
  AND r."code" = 'executive_director';
