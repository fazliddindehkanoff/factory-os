ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "supplier_name" text;
--> statement-breakpoint
ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "supplier_id" uuid REFERENCES "suppliers"("id");
--> statement-breakpoint
ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "nds_included" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "payment_type" text;
