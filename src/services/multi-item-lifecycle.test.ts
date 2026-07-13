/**
 * Multi-item requests through the full lifecycle across roles.
 *
 * The order model changed from one-product-per-request to MANY items per request.
 * The create/read paths were refactored, but the warehouse role's stock paths
 * (issue/receiving decrement/credit EVERY item's material, and a shortage on ANY
 * one item must roll the whole step back) had no end-to-end coverage. These tests
 * drive a genuinely multi-material order through the workflow and assert every
 * role's step handles ALL items, not just the first.
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

/** The canonical 8-step workflow (mirrors full-chain-e2e), reused across tests. */
async function seedWorkflow(db: any, holdingId: string) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'Multi', isActive: true }).returning();
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
  return wf;
}

describe('multi-item request — full lifecycle across roles', () => {
  it('in-stock: issue decrements EVERY item’s material, amount is the sum of items', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [matA] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
    const [matB] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Гайка' }).returning();
    await db.insert(schema.stockBalances).values([
      { holdingId: h.id, materialId: matA.id, availableQty: '100', minQty: '0' },
      { holdingId: h.id, materialId: matB.id, availableQty: '50', minQty: '0' },
    ]);
    await seedWorkflow(db, h.id);

    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');

    // Requester: one order, TWO products.
    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [
        { name: 'Болт', materialId: matA.id, quantity: 5, unitPrice: 1000 },
        { name: 'Гайка', materialId: matB.id, quantity: 10, unitPrice: 500 },
      ],
    });
    expect(req.status).toBe('pending_approval');
    // Amount = 5*1000 + 10*500 = 10000, and both rows persisted.
    expect(req.estimatedAmount).toBe(10_000);
    const items = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    expect(items.length).toBe(2);

    const act = (action: string, actorId: string, extra: Record<string, unknown> = {}) =>
      performAction(db, { requestId: req.id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    // Approver → warehouse check (in stock) → issue (skips procurement/finance/receiving) → close.
    expect((await act('approve', dh, { pin: PIN })).status).toBe('warehouse_check');
    expect((await act('wh_in_stock', wh)).status).toBe('issue');
    expect((await act('issue', wh)).status).toBe('close');
    expect((await act('close', requester)).status).toBe('closed');

    // Warehouse role drew from EACH material's stock exactly once — no phantom income.
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestId, req.id));
    expect(moves.filter((m: any) => m.movementType === 'income').length).toBe(0);
    expect(moves.filter((m: any) => m.movementType === 'outcome').length).toBe(2); // one per material
    const balA = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matA.id));
    const balB = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matB.id));
    expect(Number(balA[0].availableQty)).toBe(95); // 100 − 5
    expect(Number(balB[0].availableQty)).toBe(40); // 50 − 10
  });

  it('shortage on ONE item rolls the whole issue back — no partial stock movement', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [matA] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
    const [matB] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Гайка' }).returning();
    // matA has plenty; matB is short (need 10, have 3).
    await db.insert(schema.stockBalances).values([
      { holdingId: h.id, materialId: matA.id, availableQty: '100', minQty: '0' },
      { holdingId: h.id, materialId: matB.id, availableQty: '3', minQty: '0' },
    ]);
    await seedWorkflow(db, h.id);

    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [
        { name: 'Болт', materialId: matA.id, quantity: 5, unitPrice: 1000 },
        { name: 'Гайка', materialId: matB.id, quantity: 10, unitPrice: 500 },
      ],
    });
    const act = (action: string, actorId: string, extra: Record<string, unknown> = {}) =>
      performAction(db, { requestId: req.id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    await act('approve', dh, { pin: PIN });
    await act('wh_in_stock', wh);
    // Issue must FAIL loudly because matB is short — and roll back matA too.
    await expect(act('issue', wh)).rejects.toThrow();

    // Nothing moved: matA untouched, matB untouched, and the request did NOT advance.
    const balA = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matA.id));
    const balB = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matB.id));
    expect(Number(balA[0].availableQty)).toBe(100); // NOT 95 — rolled back
    expect(Number(balB[0].availableQty)).toBe(3);
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestId, req.id));
    expect(moves.length).toBe(0); // no partial movement persisted
    const [after] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(after.status).toBe('issue'); // still parked on the issue step, not closed
  });

  it('out-of-stock: procurement→finance→delivery→receiving credits BOTH materials, issue draws both to zero', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [matA] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
    const [matB] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Гайка' }).returning();
    // No initial stock — must be procured & received.
    await seedWorkflow(db, h.id);

    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const proc = await mkUser(db, h.id, 'procurement', 'proc');
    const procHead = await mkUser(db, h.id, 'procurement_head', 'ph');
    const fin = await mkUser(db, h.id, 'finance', 'fin', true);

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [
        { name: 'Болт', materialId: matA.id, quantity: 5, unitPrice: 1000 },
        { name: 'Гайка', materialId: matB.id, quantity: 10, unitPrice: 500 },
      ],
    });
    const act = (action: string, actorId: string, extra: Record<string, unknown> = {}) =>
      performAction(db, { requestId: req.id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    expect((await act('approve', dh, { pin: PIN })).status).toBe('warehouse_check');
    expect((await act('wh_out_of_stock', wh)).status).toBe('procurement');
    expect((await act('add_quotation', proc, { supplierName: 'ООО Крепёж', amount: 9000 })).status).toBe('finance_payment');
    expect((await act('mark_paid', fin, { pin: PIN })).status).toBe('delivery');
    expect((await act('mark_arrived', proc)).status).toBe('receiving');
    expect((await act('receive_full', wh)).status).toBe('issue');

    // Receiving credited BOTH materials (income), one movement each.
    const incomes = await db
      .select()
      .from(schema.stockMovements)
      .where(and(eq(schema.stockMovements.requestId, req.id), eq(schema.stockMovements.movementType, 'income')));
    expect(incomes.length).toBe(2);
    expect(Number((await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matA.id)))[0].availableQty)).toBe(5);
    expect(Number((await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matB.id)))[0].availableQty)).toBe(10);

    // Issue then draws BOTH back to zero.
    expect((await act('issue', wh)).status).toBe('close');
    const outcomes = await db
      .select()
      .from(schema.stockMovements)
      .where(and(eq(schema.stockMovements.requestId, req.id), eq(schema.stockMovements.movementType, 'outcome')));
    expect(outcomes.length).toBe(2);
    expect(Number((await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matA.id)))[0].availableQty)).toBe(0);
    expect(Number((await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matB.id)))[0].availableQty)).toBe(0);

    expect((await act('close', requester)).status).toBe('closed');
  });
});
