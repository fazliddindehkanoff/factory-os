/**
 * P2-3: warehouse receive/issue must reject a warehouseId or requestId from another
 * holding. No cross-tenant stock writes.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function makeApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return { app: createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true }), db };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

async function setupWarehouseUser(app: any, db: any, tgId: number) {
  const [h] = await db.insert(schema.holdings).values({ name: `H${tgId}` }).returning();
  const login = await request(app).post('/api/auth/dev').send({ telegramId: String(tgId) }).expect(200);
  const token = login.body.token as string;
  const userId = login.body.user.id as string;
  await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
  await db.insert(schema.userRoles).values({ userId, roleId: await roleId(db, 'warehouse'), holdingId: h.id });
  const [mat] = await db
    .insert(schema.materials)
    .values({ holdingId: h.id, name: 'Cotton', defaultUnit: 'kg' })
    .returning();
  const [wh] = await db.insert(schema.warehouses).values({ holdingId: h.id, name: 'WH' }).returning();
  return { token, holdingId: h.id, materialId: mat.id, warehouseId: wh.id };
}

describe('P2-3: warehouse cross-tenant guard', () => {
  it('rejects receive into another holding warehouse', async () => {
    const { app, db } = await makeApp();
    const a = await setupWarehouseUser(app, db, 701);
    const b = await setupWarehouseUser(app, db, 702);

    // Holding A user tries to receive into holding B's warehouse.
    const resp = await request(app)
      .post('/api/warehouse/receive')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ materialId: a.materialId, warehouseId: b.warehouseId, quantity: 5 })
      .expect(400);
    expect(String(resp.body.error)).toMatch(/Warehouse not found/i);

    // No stock row was created for A.
    const balances = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.holdingId, a.holdingId));
    expect(balances).toHaveLength(0);
  });

  it('rejects issue referencing another holding request', async () => {
    const { app, db } = await makeApp();
    const a = await setupWarehouseUser(app, db, 703);
    const b = await setupWarehouseUser(app, db, 704);
    const [bReq] = await db
      .insert(schema.requests)
      .values({ requestNumber: 'B-1', holdingId: b.holdingId, requesterId: (await db.select().from(schema.users).where(eq(schema.users.holdingId, b.holdingId)))[0].id })
      .returning();

    const resp = await request(app)
      .post('/api/warehouse/receive')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ materialId: a.materialId, warehouseId: a.warehouseId, quantity: 5, requestId: bReq.id })
      .expect(400);
    expect(String(resp.body.error)).toMatch(/Request not found/i);
  });

  it('allows receive within the same holding', async () => {
    const { app, db } = await makeApp();
    const a = await setupWarehouseUser(app, db, 705);
    await request(app)
      .post('/api/warehouse/receive')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ materialId: a.materialId, warehouseId: a.warehouseId, quantity: 5 })
      .expect(200);
    const balances = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.holdingId, a.holdingId));
    expect(balances.length).toBeGreaterThan(0);
  });
});
