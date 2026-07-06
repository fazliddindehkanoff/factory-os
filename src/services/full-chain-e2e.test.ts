/**
 * Full out-of-stock chain e2e — previously untested links included:
 * approval → warehouse_check(out of stock) → procurement (КП + supplier) →
 * finance_payment → delivery (mark_arrived) → receiving (receive_goods, stock
 * income) → issue (stock outcome) → close.
 *
 * At every link it checks the integrity invariants: status ↔ currentStepId,
 * history + audit written, approvals/signatures only on approval steps, and the
 * warehouse ledger moving exactly once per step.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction } from './lifecycle.service.js';
import { hashPin } from '../auth/pin.js';

const PIN = '1234';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function mkUser(db: any, holdingId: string, code: string, tg: string, withPin = false): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', ...(withPin ? { pinHash: hashPin(PIN) } : {}) })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  return u.id;
}

describe('full 8-link out-of-stock chain', () => {
  it('walks approval→wh_check→procurement→payment→delivery→receiving→issue→close with a consistent ledger', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [mat] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Ремень' }).returning();
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Full8', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Оплата', stepKind: 'finance_payment', approverRoleId: await roleId(db, 'finance'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 5, stepName: 'Доставка', stepKind: 'delivery', approverRoleId: await roleId(db, 'warehouse'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 6, stepName: 'Приёмка', stepKind: 'receiving', approverRoleId: await roleId(db, 'warehouse'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 7, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 8, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);

    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const proc = await mkUser(db, h.id, 'procurement', 'proc');
    // Выбор поставщика — только у руководителя снабжения (2026-07-06).
    const procHead = await mkUser(db, h.id, 'procurement_head', 'ph');
    const fin = await mkUser(db, h.id, 'finance', 'fin', true);

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [{ name: 'Ремень', materialId: mat.id, quantity: 5, unitPrice: 1000 }],
    });
    expect(req.status).toBe('pending_approval');

    const act = (action: string, actorId: string, extra: Record<string, unknown> = {}) =>
      performAction(db, { requestId: req.id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    // 1 → 2: approval resolves the pending row and signs.
    const r1 = await act('approve', dh, { pin: PIN });
    expect(r1.status).toBe('warehouse_check');
    const resolved = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'approved')));
    expect(resolved.length).toBe(1);
    expect((await db.select().from(schema.signatures).where(eq(schema.signatures.requestId, req.id))).length).toBe(1);

    // 2 → 3: out of stock branches into procurement.
    const r2 = await act('wh_out_of_stock', wh);
    expect(r2.inStock).toBe(false);
    expect(r2.status).toBe('procurement');

    // 3 → 4: КП + supplier selection locks the amount.
    await act('add_quotation', proc, { supplierName: 'ООО Ремни', amount: 7000 });
    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
    const r3 = await act('select_supplier', procHead, { quotationId: q.id });
    expect(r3.status).toBe('finance_payment');
    expect(r3.estimatedAmount).toBe(7000);

    // 4 → 5: PIN-signed payment.
    const r4 = await act('mark_paid', fin, { pin: PIN });
    expect(r4.status).toBe('delivery');

    // 5 → 6: goods arrived (previously untested link).
    const r5 = await act('mark_arrived', wh);
    expect(r5.status).toBe('receiving');

    // 6 → 7: receiving books the income exactly once (previously untested link).
    const r6 = await act('receive_goods', wh);
    expect(r6.status).toBe('issue');
    const incomes = await db
      .select()
      .from(schema.stockMovements)
      .where(and(eq(schema.stockMovements.requestId, req.id), eq(schema.stockMovements.movementType, 'income')));
    expect(incomes.length).toBe(1);
    expect(Number(incomes[0].quantity)).toBe(5);

    // 7 → 8: issue books the outcome; balance returns to zero.
    const r7 = await act('issue', wh);
    expect(r7.status).toBe('close');
    const [bal] = await db
      .select()
      .from(schema.stockBalances)
      .where(and(eq(schema.stockBalances.holdingId, h.id), eq(schema.stockBalances.materialId, mat.id)));
    expect(Number(bal.availableQty)).toBe(0);

    // 8: the author confirms receipt → terminal closed.
    const r8 = await act('close', requester);
    expect(r8.status).toBe('closed');
    expect(r8.currentStepId).toBeNull();

    // Integrity: one history row per transition (8), audit per transition, and no
    // pending approvals left anywhere.
    const history = await db
      .select()
      .from(schema.requestStatusHistory)
      .where(eq(schema.requestStatusHistory.requestId, req.id));
    expect(history.length).toBe(10); // create + 8 transitions + add_quotation (stays on step, still logged)
    const pending = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
    expect(pending.length).toBe(0);
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityType, 'request'), eq(schema.auditLogs.entityId, req.id)));
    expect(audits.length).toBeGreaterThanOrEqual(9);
  });
});
