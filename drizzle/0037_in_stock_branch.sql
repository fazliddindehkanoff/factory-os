-- FIXES 2026-07-20: ветка «есть в наличии» (решение владельца).
-- Если склад подтвердил полное наличие, заявка НЕ идёт дальше по закупочной
-- цепочке (гл. инженер → снабжение → директор → приёмка). Вместо этого:
-- склад «есть в наличии» → «Руководитель отдела — выдача со склада» (одобряет)
-- → «Склад — выдача в отдел» (issue, остаток списывается) → заявка закрыта.
--
-- Механика: закупочные шаги получают condition_rule {"inStock": false} — они
-- применимы только когда наличия нет; два новых шага ветки наличия получают
-- {"inStock": true}. Движок (applicableSteps/evaluateCondition) уже понимает
-- эти условия — миграция только настраивает данные. Дефолт для новых тенантов —
-- src/db/tenant-setup.ts.
DO $$
DECLARE
  wf RECORD;
  wh_order integer;
  max_order integer;
  dept_role uuid;
  wh_role uuid;
BEGIN
  FOR wf IN
    SELECT w.id, w.holding_id FROM workflows w
    WHERE EXISTS (
      SELECT 1 FROM workflow_steps s
      WHERE s.workflow_id = w.id AND s.step_kind = 'warehouse_check' AND s.enabled = true
    )
  LOOP
    SELECT MIN(step_order) INTO wh_order
    FROM workflow_steps
    WHERE workflow_id = wf.id AND step_kind = 'warehouse_check' AND enabled = true;

    -- 1) Закупочная цепочка после проверки склада — только при отсутствии на
    -- складе. Уже настроенные условия (NOT NULL) не трогаем; issue/close общие
    -- для обеих веток (пилотный маршрут wh → issue → close остаётся как был).
    UPDATE workflow_steps
    SET condition_rule = '{"inStock": false}'::jsonb
    WHERE workflow_id = wf.id
      AND step_order > wh_order
      AND condition_rule IS NULL
      AND step_kind IN ('approval','procurement_intake','procurement','price_approval','finance_payment','ordering','delivery','receiving');

    -- 2) Ветка наличия — только рабочим маршрутам без собственного issue-шага
    -- (у пилотного/полного цикла выдача уже есть — их дизайн не меняем).
    IF NOT EXISTS (SELECT 1 FROM workflow_steps WHERE workflow_id = wf.id AND step_kind = 'issue') THEN
      SELECT COALESCE(MAX(step_order), 0) INTO max_order FROM workflow_steps WHERE workflow_id = wf.id;
      SELECT id INTO dept_role FROM roles
        WHERE code = 'dept_head' AND (holding_id = wf.holding_id OR holding_id IS NULL)
        ORDER BY holding_id NULLS LAST LIMIT 1;
      SELECT id INTO wh_role FROM roles
        WHERE code = 'warehouse' AND (holding_id = wf.holding_id OR holding_id IS NULL)
        ORDER BY holding_id NULLS LAST LIMIT 1;

      IF dept_role IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_steps WHERE workflow_id = wf.id AND step_name = 'Руководитель отдела — выдача со склада'
      ) THEN
        INSERT INTO workflow_steps
          (workflow_id, step_order, step_name, step_kind, approver_type, approver_role_id, condition_rule, enabled, on_reject)
        VALUES
          (wf.id, max_order + 1, 'Руководитель отдела — выдача со склада', 'approval', 'role', dept_role, '{"inStock": true}'::jsonb, true, 'return_requester');
      END IF;

      IF wh_role IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_steps WHERE workflow_id = wf.id AND step_name = 'Склад — выдача в отдел'
      ) THEN
        INSERT INTO workflow_steps
          (workflow_id, step_order, step_name, step_kind, approver_type, approver_role_id, condition_rule, enabled, on_reject)
        VALUES
          (wf.id, max_order + 2, 'Склад — выдача в отдел', 'issue', 'role', wh_role, '{"inStock": true}'::jsonb, true, 'cancel');
      END IF;
    END IF;
  END LOOP;
END $$;
