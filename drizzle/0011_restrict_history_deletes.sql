-- P1-8: Business history must never be cascade-deleted with a request/approval.
-- Requests are archived (status), never hard-deleted, so these FKs become RESTRICT.
-- A DELETE on a request/approval that still has history now fails loudly instead
-- of silently erasing items, approvals, signatures, quotations, reservations, etc.

ALTER TABLE "request_items" DROP CONSTRAINT IF EXISTS "request_items_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "request_items" ADD CONSTRAINT "request_items_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "request_status_history" DROP CONSTRAINT IF EXISTS "request_status_history_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "request_status_history" ADD CONSTRAINT "request_status_history_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "signatures" DROP CONSTRAINT IF EXISTS "signatures_approval_id_approvals_id_fk";--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "reservations" DROP CONSTRAINT IF EXISTS "reservations_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "quotations" DROP CONSTRAINT IF EXISTS "quotations_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_request_id_requests_id_fk";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;
