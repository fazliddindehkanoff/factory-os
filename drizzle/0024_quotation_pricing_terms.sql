ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "nds_included" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN IF NOT EXISTS "payment_type" text;
