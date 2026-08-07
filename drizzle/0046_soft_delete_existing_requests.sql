-- One-time launch cleanup: hide every request that exists before this release
-- without destroying the request row or any related business history.
INSERT INTO "request_status_history" (
  "request_id", "old_status", "new_status", "changed_by", "comment", "source"
)
SELECT
  "id", "status", 'deleted', NULL,
  'Массовое удаление существующих заявок при обновлении системы', 'migration'
FROM "requests"
WHERE "status" <> 'deleted';
--> statement-breakpoint
INSERT INTO "audit_logs" (
  "holding_id", "action", "module", "entity_type", "entity_id",
  "old_value", "new_value", "comment", "source"
)
SELECT
  "holding_id", 'request.deleted', 'requests', 'request', "id",
  jsonb_build_object('status', "status"), jsonb_build_object('status', 'deleted'),
  'One-time soft deletion of pre-release requests', 'migration'
FROM "requests"
WHERE "status" <> 'deleted';
--> statement-breakpoint
UPDATE "requests"
SET
  "status" = 'deleted',
  "current_step_id" = NULL,
  "closed_at" = COALESCE("closed_at", now()),
  "updated_at" = now()
WHERE "status" <> 'deleted';
