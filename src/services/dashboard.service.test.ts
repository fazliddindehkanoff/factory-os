import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setupTenant } from '../db/tenant-setup.js';
import { createRequest } from './request.service.js';
import { getDashboard } from './dashboard.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const { holding, factory } = await setupTenant(db, { holdingName: 'Zelal', ownerTelegramId: '999' });
  const [requester] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'R', telegramId: 'r1' })
    .returning();
  return { db, holding, factory, requester };
}

async function systemRoleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

async function mkUserWithRole(db: any, holdingId: string, tg: string, roleCode: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active' })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await systemRoleId(db, roleCode), holdingId });
  return u.id;
}

/** Seed requests parked on given statuses + a low-stock balance, for aggregate tests. */
async function seedAggregates(db: any, holdingId: string, requesterId: string, factoryId: string) {
  // Attach the tenant's active workflow so role participants (finance/procurement)
  // can SEE these requests under the visibility model (real requests always have one).
  const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.holdingId, holdingId)).limit(1);
  const mk = (n: number, status: string) =>
    db.insert(schema.requests).values({
      requestNumber: `A-${status}-${n}`,
      holdingId,
      requesterId,
      status,
      workflowId: wf?.id ?? null,
    });
  await mk(1, 'finance_payment');
  await mk(2, 'finance_payment');
  await mk(1, 'procurement');

  // setupTenant seeds demo materials/balances — clear them so lowStock is deterministic.
  await db.delete(schema.stockBalances).where(eq(schema.stockBalances.holdingId, holdingId));
  const [mat] = await db.insert(schema.materials).values({ holdingId, name: 'Cotton', defaultUnit: 'kg' }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ holdingId, name: 'WH' }).returning();
  // low: available (1) <= min (5); ok: available (10) > min (5)
  await db.insert(schema.stockBalances).values({ holdingId, warehouseId: wh.id, materialId: mat.id, availableQty: '1', minQty: '5' });
  const [mat2] = await db.insert(schema.materials).values({ holdingId, name: 'Wool', defaultUnit: 'kg' }).returning();
  await db.insert(schema.stockBalances).values({ holdingId, warehouseId: wh.id, materialId: mat2.id, availableQty: '10', minQty: '5' });
}

describe('getDashboard', () => {
  it('counts the requester active requests and holding totals', async () => {
    const { db, holding, factory, requester } = await setup();
    await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester.id,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 1000 }],
    });

    const reqDash = await getDashboard(db, requester.id, holding.id);
    expect(reqDash.myActive).toBe(1);
    expect(reqDash.activity.length).toBe(1);

    const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
    const ownerDash = await getDashboard(db, owner.id, holding.id);
    expect(ownerDash.totalActive).toBe(1); // the request is pending_approval (active)
  });

  it('returns zeros/null for a user with no holding', async () => {
    const { db } = await setup();
    const d = await getDashboard(db, '00000000-0000-0000-0000-000000000000', null);
    expect(d).toEqual({
      myActive: 0,
      myReturned: 0,
      pendingForMe: 0,
      totalActive: 0,
      activity: [],
      awaitingPayment: null,
      inProcurement: null,
      lowStock: null,
      byStatus: null,
    });
  });

  // P2-1: a closed/cancelled/archived request is terminal — it must not keep
  // counting as active on the dashboard.
  it('treats closed/cancelled/archived requests as inactive', async () => {
    const { db, holding, factory, requester } = await setup();
    const [req] = await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester.id,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 1000 }],
    }).then((r) => db.select().from(schema.requests).where(eq(schema.requests.id, r.id)));

    for (const status of ['closed', 'cancelled', 'archived']) {
      await db.update(schema.requests).set({ status }).where(eq(schema.requests.id, req.id));
      const d = await getDashboard(db, requester.id, holding.id);
      expect(d.myActive, `${status} must be inactive for requester`).toBe(0);

      const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
      const od = await getDashboard(db, owner.id, holding.id);
      expect(od.totalActive, `${status} must be inactive in holding total`).toBe(0);
    }
  });
});

describe('getDashboard — Sprint 1 aggregates (role-scoped, permission-gated)', () => {
  it('owner sees all aggregates with correct counts', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));

    const d = await getDashboard(db, owner.id, holding.id);
    expect(d.awaitingPayment).toBe(2);
    expect(d.inProcurement).toBe(1);
    expect(d.lowStock).toBe(1);
    expect(d.byStatus).toMatchObject({ finance_payment: 2, procurement: 1 });
  });

  it('finance role: awaitingPayment; procurement/lowStock null; byStatus по новому праву (№14)', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const uid = await mkUserWithRole(db, holding.id, 'fin', 'finance');
    const d = await getDashboard(db, uid, holding.id);
    expect(d.awaitingPayment).toBe(2);
    expect(d.inProcurement).toBeNull();
    expect(d.lowStock).toBeNull();
    expect(d.byStatus).not.toBeNull(); // №14: reports.status_summary у системных ролей
  });

  it('procurement role: only inProcurement (+byStatus по №14)', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const uid = await mkUserWithRole(db, holding.id, 'proc', 'procurement');
    const d = await getDashboard(db, uid, holding.id);
    expect(d.inProcurement).toBe(1);
    expect(d.awaitingPayment).toBeNull();
    expect(d.lowStock).toBeNull();
    expect(d.byStatus).not.toBeNull(); // №14
  });

  it('warehouse role: only lowStock (+byStatus по №14)', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const uid = await mkUserWithRole(db, holding.id, 'warehouse', 'warehouse');
    const d = await getDashboard(db, uid, holding.id);
    expect(d.lowStock).toBe(1);
    expect(d.awaitingPayment).toBeNull();
    expect(d.inProcurement).toBeNull();
    expect(d.byStatus).not.toBeNull(); // №14
  });

  it('plain requester: no aggregates leak (all null)', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const d = await getDashboard(db, requester.id, holding.id);
    expect(d.awaitingPayment).toBeNull();
    expect(d.inProcurement).toBeNull();
    expect(d.lowStock).toBeNull();
    expect(d.byStatus).toBeNull();
  });

  it('director (oversight): byStatus + awaitingPayment; no procurement/warehouse cards', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const uid = await mkUserWithRole(db, holding.id, 'director', 'director');
    const d = await getDashboard(db, uid, holding.id);
    expect(d.byStatus).toMatchObject({ finance_payment: 2, procurement: 1 }); // reports.view/audit.view
    expect(d.awaitingPayment).toBe(2); // finance.view
    expect(d.inProcurement).toBeNull(); // no procurement.view
    expect(d.lowStock).toBeNull(); // no warehouse.view
  });

  it('auditor: byStatus only (read oversight), no money/stock cards', async () => {
    const { db, holding, factory, requester } = await setup();
    await seedAggregates(db, holding.id, requester.id, factory.id);
    const uid = await mkUserWithRole(db, holding.id, 'auditor', 'auditor');
    const d = await getDashboard(db, uid, holding.id);
    expect(d.byStatus).not.toBeNull();
    expect(d.awaitingPayment).toBeNull();
    expect(d.inProcurement).toBeNull();
    expect(d.lowStock).toBeNull();
  });
});
