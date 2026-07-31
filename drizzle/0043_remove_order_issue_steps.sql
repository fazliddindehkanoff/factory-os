-- Orders should finish at warehouse receiving for now. Remove the obsolete
-- department-issue tail that older migrations added to in-stock/order routes.
WITH obsolete_steps AS (
  SELECT id
  FROM workflow_steps
  WHERE (
    step_kind = 'issue'
    AND step_name IN ('Склад — выдача в отдел', 'Выдача со склада', 'Выдача')
  )
  OR (
    step_kind = 'approval'
    AND step_name IN ('Руководитель отдела — выдача со склада')
  )
)
UPDATE approvals a
SET workflow_step_id = NULL
FROM obsolete_steps s
WHERE a.workflow_step_id = s.id;
--> statement-breakpoint

WITH obsolete_steps AS (
  SELECT id
  FROM workflow_steps
  WHERE (
    step_kind = 'issue'
    AND step_name IN ('Склад — выдача в отдел', 'Выдача со склада', 'Выдача')
  )
  OR (
    step_kind = 'approval'
    AND step_name IN ('Руководитель отдела — выдача со склада')
  )
)
UPDATE stock_movements sm
SET workflow_step_id = NULL
FROM obsolete_steps s
WHERE sm.workflow_step_id = s.id;
--> statement-breakpoint

WITH obsolete_steps AS (
  SELECT id
  FROM workflow_steps
  WHERE (
    step_kind = 'issue'
    AND step_name IN ('Склад — выдача в отдел', 'Выдача со склада', 'Выдача')
  )
  OR (
    step_kind = 'approval'
    AND step_name IN ('Руководитель отдела — выдача со склада')
  )
)
UPDATE requests r
SET
  current_step_id = NULL,
  status = 'closed',
  closed_at = COALESCE(r.closed_at, NOW()),
  updated_at = NOW()
FROM obsolete_steps s
WHERE r.current_step_id = s.id;
--> statement-breakpoint

DELETE FROM workflow_steps ws
WHERE ws.step_kind = 'issue'
  AND ws.step_name IN ('Склад — выдача в отдел', 'Выдача со склада', 'Выдача');
--> statement-breakpoint

DELETE FROM workflow_steps ws
WHERE ws.step_kind = 'approval'
  AND ws.step_name IN ('Руководитель отдела — выдача со склада');
