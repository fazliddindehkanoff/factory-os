/**
 * Lifecycle service — performs one request status transition with the full guard
 * stack the spec requires: valid-from-status + permission + scope + PIN/comment,
 * then atomically writes the new status, a status-history row and a DNA audit log.
 */
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hasPermission, type Scope } from '../rbac/rbac.js';
import { verifyPin } from '../auth/pin.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js';
import { actionsFromStatus, findAction, STATUS_LABELS } from '../workflow/lifecycle.js';

type Db = any;

interface RequestRow {
  id: string;
  holdingId: string;
  companyId: string | null;
  factoryId: string | null;
  departmentId: string | null;
  status: string;
}

const reqScope = (r: RequestRow): Scope => ({
  holdingId: r.holdingId,
  companyId: r.companyId,
  factoryId: r.factoryId,
  departmentId: r.departmentId,
});

/** Actions the user may take on this request right now (status × permission × scope). */
export async function availableActions(
  db: Db,
  req: RequestRow,
  userId: string,
): Promise<{ action: string; label: string; pin: boolean; comment: boolean; amount: boolean; quote: 'add' | 'select' | null }[]> {
  const out: { action: string; label: string; pin: boolean; comment: boolean; amount: boolean; quote: 'add' | 'select' | null }[] = [];
  for (const a of actionsFromStatus(req.status)) {
    if (await hasPermission(db, userId, a.perm, reqScope(req))) {
      out.push({ action: a.action, label: a.label, pin: !!a.pin, comment: !!a.comment, amount: !!a.amount, quote: a.quote ?? null });
    }
  }
  return out;
}

export interface PerformInput {
  requestId: string;
  action: string;
  actor: { id: string; holdingId: string | null };
  pin?: string;
  comment?: string;
  amount?: number;
  supplierName?: string;
  leadTime?: string;
  quotationId?: string;
}

export async function performAction(db: Db, input: PerformInput) {
  const def = findAction(input.action);
  if (!def) throw new ValidationError('Неизвестное действие');

  return db.transaction(async (tx: Db) => {
    const [req] = (await tx.select().from(schema.requests).where(eq(schema.requests.id, input.requestId))) as RequestRow[];
    if (!req || req.holdingId !== input.actor.holdingId) throw new NotFoundError('Заявка не найдена');

    if (!def.from.includes(req.status)) {
      throw new ConflictError(`Действие недоступно из статуса «${STATUS_LABELS[req.status] ?? req.status}»`);
    }
    if (!(await hasPermission(tx, input.actor.id, def.perm, reqScope(req)))) {
      throw new ForbiddenError('Недостаточно прав для этого действия');
    }
    if (def.pin) {
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, input.actor.id));
      if (!u?.pinHash) throw new ForbiddenError('PIN не задан — установите его в профиле');
      if (!verifyPin(String(input.pin ?? ''), u.pinHash)) throw new ForbiddenError('Неверный PIN');
    }
    if (def.comment && !String(input.comment ?? '').trim()) {
      throw new ValidationError('Требуется комментарий');
    }

    const from = req.status;
    const to = def.to;
    const patch: Record<string, unknown> = { status: to, updatedAt: new Date() };
    if (def.amount) {
      const n = Number(input.amount);
      if (Number.isFinite(n) && n >= 0) patch.estimatedAmount = Math.round(n);
    }
    // Procurement: 'add' records a real КП (supplier/price/lead); 'select' picks one
    // of the recorded КП as the winner and locks the request's amount to its price.
    if (def.quote === 'add') {
      const amt = Math.max(0, Math.round(Number(input.amount) || 0));
      const supplier = String(input.supplierName ?? '').trim();
      if (!supplier) throw new ValidationError('Укажите поставщика');
      if (!amt) throw new ValidationError('Укажите сумму КП');
      await tx.insert(schema.quotations).values({
        holdingId: req.holdingId,
        requestId: req.id,
        supplierName: supplier,
        amount: amt,
        leadTime: String(input.leadTime ?? '').trim() || null,
        createdBy: input.actor.id,
      });
      patch.estimatedAmount = amt;
    }
    if (def.quote === 'select') {
      const [q] = await tx.select().from(schema.quotations).where(eq(schema.quotations.id, String(input.quotationId ?? '')));
      if (!q || q.requestId !== req.id) throw new ValidationError('Выберите КП поставщика');
      await tx.update(schema.quotations).set({ selected: false }).where(eq(schema.quotations.requestId, req.id));
      await tx.update(schema.quotations).set({ selected: true }).where(eq(schema.quotations.id, q.id));
      patch.estimatedAmount = q.amount;
    }
    await tx.update(schema.requests).set(patch).where(eq(schema.requests.id, req.id));
    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: from,
      newStatus: to,
      changedBy: input.actor.id,
      comment: input.comment ?? null,
      source: 'lifecycle',
    });
    await tx.insert(schema.auditLogs).values({
      holdingId: req.holdingId,
      userId: input.actor.id,
      action: `request.${def.action}`,
      module: 'lifecycle',
      entityType: 'request',
      entityId: req.id,
      oldValue: { status: from },
      newValue: { status: to },
      source: 'lifecycle',
    });

    const [updated] = await tx.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    return updated;
  });
}
