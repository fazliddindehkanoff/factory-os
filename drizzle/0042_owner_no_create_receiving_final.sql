-- Existing default tenant workflows should finish at warehouse receiving. Remove
-- the obsolete "Склад — выдача в отдел" step from the standard active chain.
DELETE FROM workflow_steps ws
USING workflows w
WHERE ws.workflow_id = w.id
  AND w.name = 'Стандартная цепочка согласования'
  AND ws.step_kind = 'issue'
  AND ws.step_name IN ('Склад — выдача в отдел', 'Выдача со склада', 'Выдача');
