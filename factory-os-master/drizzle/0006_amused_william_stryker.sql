CREATE TABLE "form_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"screen" text DEFAULT 'request_create' NOT NULL,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"placeholder" text,
	"options" jsonb,
	"step_group" integer DEFAULT 1 NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_fields_holding_screen_idx" ON "form_fields" USING btree ("holding_id","screen");--> statement-breakpoint
CREATE UNIQUE INDEX "form_fields_holding_screen_key_idx" ON "form_fields" USING btree ("holding_id","screen","field_key");