CREATE TYPE "public"."step_kind" AS ENUM('approval', 'warehouse_check', 'procurement', 'finance_payment', 'delivery', 'receiving', 'issue', 'close');--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "in_stock" boolean;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD COLUMN "step_kind" "step_kind" DEFAULT 'approval' NOT NULL;