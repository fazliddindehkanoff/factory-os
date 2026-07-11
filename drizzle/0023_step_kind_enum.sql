-- Новые типы шагов для полного воркфлоу (2026-07-11): принятие заявки снабжением,
-- проверка цены и оформление заказа. ADD VALUE идемпотентно (IF NOT EXISTS).
ALTER TYPE "step_kind" ADD VALUE IF NOT EXISTS 'procurement_intake';
--> statement-breakpoint
ALTER TYPE "step_kind" ADD VALUE IF NOT EXISTS 'price_approval';
--> statement-breakpoint
ALTER TYPE "step_kind" ADD VALUE IF NOT EXISTS 'ordering';
