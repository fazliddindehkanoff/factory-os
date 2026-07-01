ALTER TABLE "stock_movements" ADD COLUMN "workflow_step_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- M2/E2: the idempotency key now includes the workflow step and the warehouse
-- pool — a workflow may legitimately hold two receiving/issue steps, and ops in
-- different pools are distinct movements. App-level dedup (warehouse.service)
-- still treats a manual (step-null) movement and a lifecycle one in the SAME
-- pool as the same logical operation.
DROP INDEX IF EXISTS stock_movements_idem_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idem_idx
  ON stock_movements (
    request_id,
    material_id,
    movement_type,
    COALESCE(workflow_step_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE request_id IS NOT NULL;
