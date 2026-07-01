-- CRIT-10: Prevent duplicate stock balances for same material in same warehouse
CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_uniq
  ON stock_balances (holding_id, material_id, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'));
--> statement-breakpoint
-- CRIT-10: Safety net — stock can never go negative
ALTER TABLE stock_balances ADD CONSTRAINT stock_avail_nonneg CHECK (available_qty::numeric >= 0);
--> statement-breakpoint
-- CRIT-22: Protect system roles (NULL holdingId) from duplication
CREATE UNIQUE INDEX IF NOT EXISTS roles_system_code_unique
  ON roles (code) WHERE holding_id IS NULL;
--> statement-breakpoint
-- HIGH-23: Composite index for common query pattern
CREATE INDEX IF NOT EXISTS requests_holding_status_idx
  ON requests (holding_id, status);
--> statement-breakpoint
-- HIGH-24: Index for warehouse movement queries
CREATE INDEX IF NOT EXISTS stock_movements_warehouse_idx
  ON stock_movements (warehouse_id);
--> statement-breakpoint
-- Idempotency guard for stock movements
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idem_idx
  ON stock_movements (request_id, material_id, movement_type) WHERE request_id IS NOT NULL;
