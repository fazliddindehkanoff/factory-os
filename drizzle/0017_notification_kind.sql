-- Уведомления: тип события (kind) для осмысленных тегов в UI — «Ждёт вас»,
-- «Согласована», «Отклонена», «На доработку» и т.д. вместо статуса доставки.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
-- Ретро-фикс семантики доставки: in-app уведомление доставлено самим фактом
-- записи. Строки, помеченные failed лишь из-за отсутствия Telegram-канала
-- (стенд без BOT_TOKEN / пользователь без telegram_id / админ-роутер),
-- переводятся в delivered без технической «причины».
UPDATE "notifications"
SET "status" = 'delivered',
    "channel" = 'inapp',
    "delivered_at" = COALESCE("delivered_at", "created_at"),
    "error_message" = NULL
WHERE "status" = 'failed'
  AND "error_message" IN ('no delivery channel configured', 'recipient has no telegram id');
