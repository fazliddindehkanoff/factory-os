/**
 * P2.3 Procurement Lite — suppliers CRUD, procurement queue, supplier-linked
 * quotations, single-quotation warning, and the RBAC around them.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from '../services/request.service.js';
import { performAction } from '../services/lifecycle.service.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  return { app, db, holding, factory };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}
async function userWithRole(db: any, holding: any, code: string, tg: string): Promise<string> {
  const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: code, telegramId: tg, status: 'active' }).returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId: holding.id });
  return u.id;
}
async function login(app: any, tg: string): Promise<string> {
  return (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
}

describe('procurement lite — suppliers CRUD (HTTP)', () => {
  it('GET requires suppliers.view; mutations require suppliers.manage', async () => {
    const { app, db, holding } = await make();
    await userWithRole(db, holding, 'procurement_manager', 'proc');
    await userWithRole(db, holding, 'requester', 'req');
    const procTk = await login(app, 'proc');
    const reqTk = await login(app, 'req');

    await request(app).get('/api/suppliers').set('Authorization', `Bearer ${reqTk}`).expect(403);
    await request(app).get('/api/suppliers').set('Authorization', `Bearer ${procTk}`).expect(200);

    await request(app).post('/api/suppliers').set('Authorization', `Bearer ${reqTk}`).send({ name: 'X' }).expect(403);
    const created = await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${procTk}`)
      .send({ name: 'ООО Поставка', inn: '123', phone: '+998' })
      .expect(201);
    expect(created.body.name).toBe('ООО Поставка');
    expect(created.body.status).toBe('active');
  });

  it('DELETE archives a supplier (never hard-deletes) and hides it from the active list', async () => {
    const { app, db, holding } = await make();
    await userWithRole(db, holding, 'procurement_manager', 'proc');
    const tk = await login(app, 'proc');
    const created = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${tk}`).send({ name: 'S' }).expect(201);
    const id = created.body.id;

    await request(app).delete(`/api/suppliers/${id}`).set('Authorization', `Bearer ${tk}`).expect(200);
    const [row] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    expect(row.status).toBe('archived'); // row preserved
    const list = await request(app).get('/api/suppliers').set('Authorization', `Bearer ${tk}`).expect(200);
    expect(list.body.some((s: { id: string }) => s.id === id)).toBe(false);
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'supplier.archived'));
    expect(audit.length).toBe(1);
  });
});

describe('procurement lite — queue + quotation flow', () => {
  // Workflow: procurement (procurement_head) -> close (requester)
  async function procurementRequest(db: any, holding: any, factory: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Proc', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: holding.id, requesterId, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }
  async function supplier(db: any, holdingId: string, name = 'ООО Поставка') {
    const [s] = await db.insert(schema.suppliers).values({ holdingId, name }).returning();
    return s;
  }

  it('procurement queue: visible to procurement, forbidden to requester', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRole(db, holding, 'requester', 'r1');
    await userWithRole(db, holding, 'procurement_manager', 'p1');
    await procurementRequest(db, holding, factory, requester);

    const reqTk = await login(app, 'r1');
    await request(app).get('/api/procurement/queue').set('Authorization', `Bearer ${reqTk}`).expect(403);
    const procTk = await login(app, 'p1');
    const q = await request(app).get('/api/procurement/queue').set('Authorization', `Bearer ${procTk}`).expect(200);
    expect(q.body.length).toBe(1);
  });

  it('procurement_manager adds one supplier-linked proposal; it auto-selects and advances', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRole(db, holding, 'requester', 'r2');
    const proc = await userWithRole(db, holding, 'procurement_manager', 'p2');
    const req = await procurementRequest(db, holding, factory, requester);
    expect(req.status).toBe('procurement');
    const sup = await supplier(db, holding.id);

    const r = await performAction(db, {
      requestId: req.id,
      action: 'add_quotation',
      actor: { id: proc, holdingId: holding.id },
      supplierId: sup.id,
      amount: 5000,
    });
    expect(r.status).toBe('close');
    expect(r.estimatedAmount).toBe(5000);
    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
    expect(q.supplierId).toBe(sup.id);
    expect(q.supplierName).toBe(sup.name); // snapshot
    expect(q.selected).toBe(true);
  });

  it('add_quotation rejects a supplier from another holding (scope guard)', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRole(db, holding, 'requester', 'r3');
    const proc = await userWithRole(db, holding, 'procurement_manager', 'p3');
    const req = await procurementRequest(db, holding, factory, requester);
    const [otherHolding] = await db.insert(schema.holdings).values({ name: 'Other' }).returning();
    const otherSup = await supplier(db, otherHolding.id);

    await expect(
      performAction(db, { requestId: req.id, action: 'add_quotation', actor: { id: proc, holdingId: holding.id }, supplierId: otherSup.id, amount: 1000 }),
    ).rejects.toThrow(/Поставщик не найден/);
  });

  it('warehouse cannot add a quotation (no procurement permission)', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRole(db, holding, 'requester', 'r4');
    const wh = await userWithRole(db, holding, 'warehouse', 'w4');
    const req = await procurementRequest(db, holding, factory, requester);
    const sup = await supplier(db, holding.id);

    await expect(
      performAction(db, { requestId: req.id, action: 'add_quotation', actor: { id: wh, holdingId: holding.id }, supplierId: sup.id, amount: 1000 }),
    ).rejects.toThrow();
  });

});
