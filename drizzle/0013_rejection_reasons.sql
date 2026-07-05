-- Bug #3: configurable rejection reasons (presets shown in the reject dialog).
CREATE TABLE IF NOT EXISTS "rejection_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid,
	"role_code" text,
	"text" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rejection_reasons" ADD CONSTRAINT "rejection_reasons_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rejection_reasons_role_idx" ON "rejection_reasons" ("role_code");
