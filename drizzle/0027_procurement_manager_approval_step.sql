WITH procurement_steps AS (
  SELECT ws.workflow_id, ws.step_order, ws.approver_role_id, ws.condition_rule
  FROM "workflow_steps" ws
  WHERE ws."step_kind" = 'procurement'
    AND ws."enabled" = true
    AND NOT EXISTS (
      SELECT 1
      FROM "workflow_steps" existing
      WHERE existing."workflow_id" = ws."workflow_id"
        AND existing."step_kind" = 'price_approval'
        AND existing."enabled" = true
        AND existing."step_order" > ws."step_order"
    )
),
shifted AS (
  UPDATE "workflow_steps" target
  SET "step_order" = target."step_order" + 1
  FROM procurement_steps ps
  WHERE target."workflow_id" = ps."workflow_id"
    AND target."step_order" > ps."step_order"
  RETURNING target.id
)
INSERT INTO "workflow_steps" (
  "workflow_id",
  "step_order",
  "step_name",
  "step_kind",
  "approver_role_id",
  "condition_rule",
  "enabled"
)
SELECT
  ps."workflow_id",
  ps."step_order" + 1,
  'Снабжение — менеджер',
  'price_approval',
  ps."approver_role_id",
  ps."condition_rule",
  true
FROM procurement_steps ps;
