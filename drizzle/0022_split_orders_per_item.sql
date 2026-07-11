-- Полный воркфлоу заявки (2026-07-11): действия по каждому продукту.
-- 1) Дробление заявки: out-of-stock позиции уходят в НОВУЮ заявку, ссылающуюся на
--    исходную (parent_request_id, self-FK).
-- 2) order_status — под-состояние шага «Оформление заказа» (#10).
-- 3) request_items.received_qty — фактически принятое количество (#11, расхождения).
ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "parent_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "order_status" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "requests"
    ADD CONSTRAINT "requests_parent_request_id_fk"
    FOREIGN KEY ("parent_request_id") REFERENCES "requests"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "request_items" ADD COLUMN IF NOT EXISTS "received_qty" numeric DEFAULT '0' NOT NULL;
