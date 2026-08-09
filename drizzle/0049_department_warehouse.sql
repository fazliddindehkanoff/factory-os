CREATE TABLE IF NOT EXISTS "department_warehouses" (
  "department_id" uuid PRIMARY KEY REFERENCES "departments"("id") ON DELETE CASCADE,
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id"),
  "warehouse_id" uuid NOT NULL REFERENCES "warehouses"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "department_warehouses_holding_idx" ON "department_warehouses" ("holding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "department_warehouses_warehouse_idx" ON "department_warehouses" ("warehouse_id");
