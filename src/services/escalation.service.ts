/**
 * Эскалация по таймауту шага (2026-07-07).
 *
 * Заявка, висящая на шаге дольше положенного, не должна ждать, пока о ней
 * вспомнят. Таймаут шага: workflow_steps.timeout_hours; если у шага он не
 * задан — дефолт холдинга из настройки `step_timeout_hours` (нет ни того, ни
 * другого → шаг не эскалируется).
 *
 * Уровни:
 *  - L1 (просрочка ≥ 1×таймаут): напоминание ответственным текущего шага;
 *  - L2 (просрочка ≥ 2×таймаут): сигнал держателям approvals.override
 *    (учредитель/владелец) — «заявка стоит, нужен пинок сверху».
 *
 * Дедуп — через саму таблицу notifications: считаем kind='escalation' по
 * заявке, созданные ПОСЛЕ входа на текущий шаг. 0 → можно L1, 1 → можно L2,
 * ≥2 → по этому шагу всё сказано (смена шага обнуляет счётчик сама собой).
 *
 * Время входа на шаг — начало верхней непрерывной серии записей
 * request_status_history с newStatus = текущему статусу (непродвигающие
 * действия пишут историю с тем же статусом и серию не рвут… но продлевают её
 * вглубь — поэтому идём от новых к старым до первой ЧУЖОЙ записи).
 */
import { and, desc, eq, gt, notInArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { TERMINAL_STATUSES } from '../workflow/step-kinds.js';
import { notifyUser, type DeliverFn } from './notification.service.js';
import { escalationReminderMessage, escalationOverdueMessage } from '../bot/messages.js';
import { stepActorIds, holdingSetting } from './step-actors.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';

type Db = any;

const HOUR_MS = 3_600_000;

/** Пользователи холдинга с данным правом (для L2 — approvals.override). */
async function holdersOfPerm(db: Db, holdingId: string, perm: string): Promise<string[]> {
  const users = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.holdingId, holdingId), eq(schema.users.status, 'active')));
  const out: string[] = [];
  for (const u of users as { id: string }[]) {
    const codes = await getUserPermissionCodes(db, u.id);
    if (codes.includes(perm)) out.push(u.id);
  }
  return out;
}

async function stepEnteredAt(db: Db, req: { id: string; status: string; createdAt: unknown }): Promise<Date> {
  const hist = await db
    .select({ newStatus: schema.requestStatusHistory.newStatus, createdAt: schema.requestStatusHistory.createdAt })
    .from(schema.requestStatusHistory)
    .where(eq(schema.requestStatusHistory.requestId, req.id))
    .orderBy(desc(schema.requestStatusHistory.createdAt));
  let entered: Date | null = null;
  for (const h of hist as { newStatus: string; createdAt: Date }[]) {
    if (h.newStatus === req.status) entered = new Date(h.createdAt);
    else break;
  }
  return entered ?? new Date(req.createdAt as string);
}

export interface EscalationResult {
  checked: number;
  remindersSent: number;
  overdueSent: number;
}

export async function runEscalations(db: Db, deliver: DeliverFn | undefined, opts: { now?: Date } = {}): Promise<EscalationResult> {
  const now = opts.now ?? new Date();
  const result: EscalationResult = { checked: 0, remindersSent: 0, overdueSent: 0 };

  // Все живые заявки на каком-либо шаге, вместе с шагом.
  const rows = await db
    .select({ r: schema.requests, s: schema.workflowSteps })
    .from(schema.requests)
    .innerJoin(schema.workflowSteps, eq(schema.requests.currentStepId, schema.workflowSteps.id))
    .where(notInArray(schema.requests.status, [...TERMINAL_STATUSES, 'draft']));

  const defaultByHolding = new Map<string, number | null>();

  for (const { r, s } of rows as { r: any; s: any }[]) {
    let timeout: number | null = s.timeoutHours != null ? Number(s.timeoutHours) : null;
    if (timeout == null) {
      if (!defaultByHolding.has(r.holdingId)) {
        const v = await holdingSetting(db, r.holdingId, 'step_timeout_hours');
        const n = v != null ? Number(v) : NaN;
        defaultByHolding.set(r.holdingId, Number.isFinite(n) && n > 0 ? n : null);
      }
      timeout = defaultByHolding.get(r.holdingId) ?? null;
    }
    if (!timeout || timeout <= 0) continue;
    result.checked++;

    const entered = await stepEnteredAt(db, r);
    const overdueHours = (now.getTime() - entered.getTime()) / HOUR_MS;
    if (overdueHours < timeout) continue;

    // Дедуп: эскалации по ТЕКУЩЕМУ пребыванию на шаге (созданные после входа).
    // Маркер уровня — priority: L1 = urgent, L2 = critical.
    const waves = await db
      .select({ priority: schema.notifications.priority })
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.kind, 'escalation'),
        eq(schema.notifications.entityId, r.id),
        gt(schema.notifications.createdAt, entered),
      ));
    const l1Done = (waves as { priority: string }[]).some((w) => w.priority === 'urgent');
    const l2Done = (waves as { priority: string }[]).some((w) => w.priority === 'critical');

    const hours = Math.floor(overdueHours);
    if (!l1Done) {
      const actorIds = await stepActorIds(db, r, s);
      for (const uId of actorIds) {
        await notifyUser(db, deliver, {
          holdingId: r.holdingId,
          recipientUserId: uId,
          title: `⏰ Просрочка — ${r.requestNumber}`,
          message: escalationReminderMessage(r.requestNumber, s.stepName, hours),
          priority: 'urgent',
          kind: 'escalation',
          entityType: 'request',
          entityId: r.id,
        });
        result.remindersSent++;
      }
    } else if (!l2Done && overdueHours >= timeout * 2) {
      // Вышестоящим — но не тем, кто сам держит шаг (они уже получили L1).
      const actorIds = new Set(await stepActorIds(db, r, s));
      const bosses = (await holdersOfPerm(db, r.holdingId, 'approvals.override')).filter((id) => !actorIds.has(id));
      for (const uId of bosses) {
        await notifyUser(db, deliver, {
          holdingId: r.holdingId,
          recipientUserId: uId,
          title: `🚨 Заявка стоит — ${r.requestNumber}`,
          message: escalationOverdueMessage(r.requestNumber, s.stepName, hours),
          priority: 'critical',
          kind: 'escalation',
          entityType: 'request',
          entityId: r.id,
        });
        result.overdueSent++;
      }
    }
  }
  return result;
}
