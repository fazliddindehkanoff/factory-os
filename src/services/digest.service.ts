/**
 * Дайджест уведомлений (2026-07-07): «сводка вместо потока».
 *
 * Настройка холдинга `notification_digest` = интервал в МИНУТАХ ('0'/пусто —
 * выключено). Когда включено:
 *  - мгновенные «Ждёт вас» (kind=step_pending) пишутся только in-app —
 *    TG-пуш на каждое событие подавляется (routes.notifyStepApprovers);
 *  - раз в интервал пользователю уходит ОДНА TG-сводка «N заявок ждут вашего
 *    решения» (kind=digest) — и только если с прошлой сводки появились новые
 *    непрочитанные «Ждёт вас», а инбокс сейчас непуст.
 *
 * Метка «когда пользователю слали сводку в последний раз» — его последняя
 * notification kind='digest' (отдельного состояния нет).
 */
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { notifyUser, type DeliverFn } from './notification.service.js';
import { digestMessage } from '../bot/messages.js';
import { holdingSetting } from './step-actors.js';
import { inboxCandidates, availableActions } from './lifecycle.service.js';

type Db = any;

const MIN_MS = 60_000;

export interface DigestResult {
  holdingsChecked: number;
  digestsSent: number;
}

/** Интервал дайджеста холдинга в минутах, или null (выключен). */
export async function digestIntervalMinutes(db: Db, holdingId: string): Promise<number | null> {
  const v = await holdingSetting(db, holdingId, 'notification_digest');
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function runDigests(db: Db, deliver: DeliverFn | undefined, opts: { now?: Date } = {}): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const result: DigestResult = { holdingsChecked: 0, digestsSent: 0 };

  const holdings = await db.select({ id: schema.holdings.id }).from(schema.holdings);
  for (const h of holdings as { id: string }[]) {
    const interval = await digestIntervalMinutes(db, h.id);
    if (!interval) continue;
    result.holdingsChecked++;

    // Кандидаты: получатели непрочитанных «Ждёт вас» в этом холдинге.
    const pendingRows = await db
      .select({
        recipient: schema.notifications.recipientUserId,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.holdingId, h.id),
        eq(schema.notifications.kind, 'step_pending'),
        ne(schema.notifications.status, 'read'),
      ));
    if (!pendingRows.length) continue;
    const newestPendingBy = new Map<string, number>();
    for (const p of pendingRows as { recipient: string; createdAt: Date }[]) {
      const t = new Date(p.createdAt).getTime();
      if (t > (newestPendingBy.get(p.recipient) ?? 0)) newestPendingBy.set(p.recipient, t);
    }

    const userIds = [...newestPendingBy.keys()];
    // Последний дайджест каждого кандидата — одним запросом.
    const lastDigests = userIds.length
      ? await db
          .select({ recipient: schema.notifications.recipientUserId, createdAt: schema.notifications.createdAt })
          .from(schema.notifications)
          .where(and(eq(schema.notifications.kind, 'digest'), inArray(schema.notifications.recipientUserId, userIds)))
          .orderBy(desc(schema.notifications.createdAt))
      : [];
    const lastDigestBy = new Map<string, number>();
    for (const d of lastDigests as { recipient: string; createdAt: Date }[]) {
      if (!lastDigestBy.has(d.recipient)) lastDigestBy.set(d.recipient, new Date(d.createdAt).getTime());
    }

    for (const uId of userIds) {
      const last = lastDigestBy.get(uId) ?? 0;
      if (now.getTime() - last < interval * MIN_MS) continue; // интервал ещё не вышел
      if ((newestPendingBy.get(uId) ?? 0) <= last) continue; // ничего нового с прошлой сводки

      // Что РЕАЛЬНО ждёт сейчас (кандидаты + финальная проверка действий).
      const candidates = await inboxCandidates(db, uId, h.id);
      const waiting: { requestNumber: string }[] = [];
      for (const c of candidates) {
        if ((await availableActions(db, c, uId)).length) waiting.push({ requestNumber: (c as any).requestNumber });
        if (waiting.length >= 25) break; // сводке хватит
      }
      if (!waiting.length) continue;

      await notifyUser(db, deliver, {
        holdingId: h.id,
        recipientUserId: uId,
        title: `Сводка: ждут вашего решения — ${waiting.length}`,
        message: digestMessage(waiting.length, waiting.slice(0, 5).map((w) => w.requestNumber)),
        priority: 'high',
        kind: 'digest',
        entityType: null,
        entityId: null,
      });
      result.digestsSent++;
    }
  }
  return result;
}
