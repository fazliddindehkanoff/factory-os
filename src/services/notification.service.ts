/**
 * P1-6: persistent notifications.
 *
 * Every critical notification is written to the `notifications` table BEFORE we
 * attempt delivery. If the Telegram send fails (user blocked the bot, network,
 * etc.) the row is marked `failed` with the error — it is never lost the way the
 * old fire-and-forget notifier lost it. Failed rows can be retried.
 *
 * `deliver` is injected (a promise-returning Telegram send) so this layer is
 * fully testable without a real bot.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import * as schema from '../db/schema.js';

type Db = any;

/** Promise-returning delivery channel. Rejects on failure so we can record it. */
export type DeliverFn = (telegramId: string, text: string) => Promise<void>;

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent' | 'critical';

/**
 * Тип события — источник осмысленного тега в UI («Ждёт вас», «Согласована»,
 * «Отклонена»...). Статус доставки — отдельная ось и в теге не участвует.
 */
export type NotificationKind =
  | 'step_pending'
  | 'stage_passed'
  | 'approved_final'
  | 'rejected'
  | 'needs_revision'
  | 'returned_step'
  | 'closed'
  | 'security'
  | 'escalation'
  | 'digest';

export interface NotifyInput {
  holdingId?: string | null;
  recipientUserId: string;
  title: string;
  message: string;
  priority?: NotificationPriority;
  kind?: NotificationKind | null;
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
}

/**
 * Persist a notification, then try to deliver it. Returns the stored row.
 * Delivery failure does NOT throw — it is recorded as status='failed'.
 */
export async function notifyUser(db: Db, deliver: DeliverFn | undefined, input: NotifyInput) {
  const [row] = await db
    .insert(schema.notifications)
    .values({
      holdingId: input.holdingId ?? null,
      recipientUserId: input.recipientUserId,
      title: input.title,
      message: input.message,
      priority: input.priority ?? 'normal',
      kind: input.kind ?? null,
      channel: 'telegram',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actionUrl: input.actionUrl ?? null,
      status: 'pending',
    })
    .returning();

  await deliverRow(db, deliver, row);
  return row;
}

/** Deliver a single stored notification row, updating its status in place. */
async function deliverRow(db: Db, deliver: DeliverFn | undefined, row: any): Promise<boolean> {
  const [recipient] = await db.select().from(schema.users).where(eq(schema.users.id, row.recipientUserId));
  const telegramId = recipient?.telegramId;

  if (!deliver || !telegramId) {
    // In-app уведомление доставлено самим фактом записи в таблицу. Отсутствие
    // Telegram-канала (стенд/дев без BOT_TOKEN, пользователь без telegram_id,
    // админ-роутер без бота) — НЕ сбой: раньше такие строки помечались failed
    // и весь экран «Уведомления» краснел «Не доставлено: no delivery channel
    // configured». failed остаётся только за реальной ошибкой отправки в TG.
    await db
      .update(schema.notifications)
      .set({ status: 'delivered', channel: 'inapp', deliveredAt: new Date(), errorMessage: null })
      .where(eq(schema.notifications.id, row.id));
    return true;
  }

  try {
    await deliver(telegramId, `${row.title}\n\n${row.message}`.trim());
    await db
      .update(schema.notifications)
      .set({ status: 'delivered', deliveredAt: new Date(), errorMessage: null })
      .where(eq(schema.notifications.id, row.id));
    return true;
  } catch (e) {
    await db
      .update(schema.notifications)
      .set({ status: 'failed', errorMessage: String((e as Error)?.message ?? e).slice(0, 500) })
      .where(eq(schema.notifications.id, row.id));
    return false;
  }
}

/** List a user's own notifications (newest first). */
export async function listUserNotifications(
  db: Db,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.unreadOnly
    ? and(eq(schema.notifications.recipientUserId, userId), ne(schema.notifications.status, 'read'))
    : eq(schema.notifications.recipientUserId, userId);
  return db
    .select()
    .from(schema.notifications)
    .where(where)
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit);
}

/**
 * Count a user's unread notifications. In-app a notification exists regardless
 * of whether the Telegram push made it out, so `pending`/`failed` are unread
 * too — otherwise a stand without BOT_TOKEN always shows a zero badge.
 */
export async function unreadCount(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.recipientUserId, userId), ne(schema.notifications.status, 'read')));
  return rows.length;
}

/** Mark one of the user's own notifications as read. Returns false if not theirs. */
export async function markRead(db: Db, userId: string, id: string): Promise<boolean> {
  const res = await db
    .update(schema.notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.recipientUserId, userId)))
    .returning();
  return res.length > 0;
}

/** Mark all of the user's unread notifications as read. */
export async function markAllRead(db: Db, userId: string): Promise<number> {
  const res = await db
    .update(schema.notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(and(eq(schema.notifications.recipientUserId, userId), ne(schema.notifications.status, 'read')))
    .returning();
  return res.length;
}

/**
 * Retry delivery of failed notifications (best-effort). Returns how many now
 * succeeded. Exposed for an admin action / cron script.
 */
export async function retryFailedNotifications(
  db: Db,
  deliver: DeliverFn | undefined,
  opts: { limit?: number } = {},
): Promise<{ attempted: number; delivered: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const failed = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.status, 'failed'))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit);

  let delivered = 0;
  for (const row of failed) {
    if (await deliverRow(db, deliver, row)) delivered++;
  }
  return { attempted: failed.length, delivered };
}
