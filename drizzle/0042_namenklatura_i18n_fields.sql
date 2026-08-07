ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "name_uz" text;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "name_tr" text;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "name_uz" text;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "name_tr" text;--> statement-breakpoint
CREATE TABLE "unit_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_ru" text NOT NULL,
	"name_uz" text,
	"name_tr" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	"status" "entity_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unit_types_holding_idx" ON "unit_types" USING btree ("holding_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_unique" UNIQUE("phone");
