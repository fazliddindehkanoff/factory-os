-- Ветка отклонения (if/else в конструкторе маршрутов): каждый шаг настраивает,
-- что происходит при «Отклонить» — отменить заявку (как раньше), вернуть автору
-- на доработку (needs_revision + повторная отправка) или вернуть на более
-- ранний шаг маршрута.
ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "on_reject" text DEFAULT 'cancel' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "on_reject_step_order" integer;
