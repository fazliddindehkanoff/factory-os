/**
 * Tests for endpoints added in the fix session: PUT /requests/:id, warehouse,
 * attachments, materials, paginated GET /requests, rate limiting, PIN lockout.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

function initData(id: number): string {
  const p = new URLSearchParams();
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('user', JSON.stringify({ id, first_name: 'T' }));
  const dcs = [...p.keys()].sort().map((k) => `${k}=${p.get(k)}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

async function makeApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return { app: createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false }), db };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

/** Create a fully provisioned test user with a holding and role. */
async function setupUser(app: any, db: any, tgId: number, roleCode: string) {
  const [h] = await db.insert(schema.holdings).values({ name: `H${tgId}` }).returning();
  const login = await request(app).post('/api/auth/dev').send({ telegramId: String(tgId) }).expect(200);
  const token = login.body.token as string;
  const userId = login.body.user.id as string;
  await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
  await db.insert(schema.userRoles).values({ userId, roleId: await roleId(db, roleCode), holdingId: h.id });
  return { token, userId, holdingId: h.id };
}

describe('Paginated GET /requests', () => {
  it('rejects request creation from the owner/founder role', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 99, 'owner');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });

    await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ items: [{ name: 'Owner item', quantity: 1, unitPrice: 100 }] }).expect(403);
  });

  it('returns {items, hasMore} with pagination', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId, userId } = await setupUser(app, db, 100, 'requester');

    // Create a workflow so requests aren't auto-approved without steps
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });

    // Create 5 requests
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
        .send({ items: [{ name: `Item ${i}`, quantity: 1, unitPrice: 100 }] }).expect(201);
    }

    const page1 = await request(app).get('/api/requests?limit=3&offset=0')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(page1.body.items.length).toBe(3);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await request(app).get('/api/requests?limit=3&offset=3')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(page2.body.items.length).toBe(2);
    expect(page2.body.hasMore).toBe(false);
  });
});

describe('PUT /requests/:id (edit)', () => {
  it('allows the author to edit title and description', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 200, 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });

    const created = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Old', items: [{ name: 'X', quantity: 1, unitPrice: 1 }] }).expect(201);

    const updated = await request(app).put(`/api/requests/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Title', description: 'Added desc' }).expect(200);

    expect(updated.body.title).toBe('New Title');
    expect(updated.body.description).toBe('Added desc');
  });

  it('allows the author to edit request items while the request is editable', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 201, 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });

    const created = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Needs parts', items: [{ name: 'Old Bolt', quantity: 1, unit: 'pcs', unitPrice: 10 }] }).expect(201);

    await request(app).put(`/api/requests/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Needs better parts',
        items: [
          { name: 'New Bolt', quantity: 3, unit: 'pcs', description: 'M8', unitPrice: 10 },
          { name: 'Washer', quantity: 5, unit: 'pcs', description: 'Flat', unitPrice: 2 },
        ],
      }).expect(200);

    const items = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, created.body.id));
    expect(items.map((it) => it.name).sort()).toEqual(['New Bolt', 'Washer']);
    expect(items.find((it) => it.name === 'New Bolt')?.quantity).toBe('3');
    const [reqRow] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.body.id));
    expect(reqRow.estimatedAmount).toBe(40);
  });

  it('allows a department-head author to edit after their own approval step is auto-skipped', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 202, 'dept_head');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'Dept head flow', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      {
        workflowId: wf.id,
        stepOrder: 1,
        stepName: 'Руководитель отдела',
        stepKind: 'approval',
        approverRoleId: await roleId(db, 'dept_head'),
      },
      {
        workflowId: wf.id,
        stepOrder: 2,
        stepName: 'Склад — наличие',
        stepKind: 'warehouse_check',
        approverRoleId: await roleId(db, 'warehouse'),
      },
    ]);

    const created = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Old dept request', items: [{ name: 'X', quantity: 1, unitPrice: 1 }] }).expect(201);
    expect(created.body.status).toBe('warehouse_check');

    const detail = await request(app).get(`/api/requests/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(detail.body.canEdit).toBe(true);

    const updated = await request(app).put(`/api/requests/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated dept request' }).expect(200);
    expect(updated.body.title).toBe('Updated dept request');
  });
});

describe('Warehouse endpoints', () => {
  it('GET /warehouse/balances returns 403 without permission', async () => {
    const { app, db } = await makeApp();
    const { token } = await setupUser(app, db, 300, 'requester');
    await request(app).get('/api/warehouse/balances').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('GET /warehouse/balances returns 200 for warehouse role', async () => {
    const { app, db } = await makeApp();
    const { token } = await setupUser(app, db, 301, 'warehouse');
    const res = await request(app).get('/api/warehouse/balances').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Attachments endpoints', () => {
  it('upload + list + delete cycle works', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 400, 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });

    const req = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ items: [{ name: 'X', quantity: 1, unitPrice: 1 }] }).expect(201);

    // Upload
    const uploaded = await request(app).post(`/api/requests/${req.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.txt', dataBase64: Buffer.from('hello').toString('base64') })
      .expect(201);
    expect(uploaded.body.id).toBeTruthy();

    // List
    const list = await request(app).get(`/api/requests/${req.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].filename).toBe('test.txt');

    // Download
    const dl = await request(app).get(`/api/attachments/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .expect(200);
    expect(dl.body.toString()).toBe('hello');

    // Delete
    await request(app).delete(`/api/attachments/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    // Verify deleted
    const list2 = await request(app).get(`/api/requests/${req.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list2.body.length).toBe(0);
  });

  it('rejects files > 2MB', async () => {
    const { app, db } = await makeApp();
    const { token, holdingId } = await setupUser(app, db, 401, 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'S',
      approverRoleId: await roleId(db, 'dept_head'),
    });
    const req = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`)
      .send({ items: [{ name: 'X', quantity: 1, unitPrice: 1 }] }).expect(201);

    const bigData = Buffer.alloc(2.1 * 1024 * 1024).toString('base64');
    await request(app).post(`/api/requests/${req.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'big.bin', dataBase64: bigData })
      .expect(413);
  });
});

describe('Admin materials CRUD', () => {
  it('create + list + update + delete', async () => {
    const { app, db } = await makeApp();
    const { token } = await setupUser(app, db, 500, 'owner');

    // Create
    const created = await request(app).post('/api/admin/materials')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bolt M8', sku: 'BLT-M8', category: 'Fasteners', defaultUnit: 'pcs', characteristics: 'M8 x 40', brand: 'Bosch' })
      .expect(201);
    expect(created.body.name).toBe('Bolt M8');
    expect(created.body.category).toBe('Fasteners');
    expect(created.body.characteristics).toBe('M8 x 40');
    expect(created.body.brand).toBe('Bosch');

    // List
    const list = await request(app).get('/api/admin/materials')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.length).toBe(1);

    // Update
    const updated = await request(app).put(`/api/admin/materials/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bolt M10', category: 'Hardware', characteristics: 'M10 x 50', brand: 'Makita' }).expect(200);
    expect(updated.body.name).toBe('Bolt M10');
    expect(updated.body.category).toBe('Hardware');
    expect(updated.body.characteristics).toBe('M10 x 50');
    expect(updated.body.brand).toBe('Makita');

    // Delete (archive)
    await request(app).delete(`/api/admin/materials/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    // Verify archived (not in list)
    const list2 = await request(app).get('/api/admin/materials')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list2.body.length).toBe(0);
  });

  it('imports catalog from Excel and updates existing products by code', async () => {
    const { app, db } = await makeApp();
    const { token } = await setupUser(app, db, 501, 'owner');

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Код', 'Наименование', 'Категория', 'Ед. измерения', 'Характеристики', 'Бренд'],
      ['BLT-M8', 'Bolt M8', 'Fasteners', 'шт', 'M8 x 40', 'Bosch'],
      ['NUT-M8', 'Nut M8', 'Fasteners', 'кг', 'M8', 'Makita'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Каталог');
    const dataBase64 = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })).toString('base64');

    const imported = await request(app).post('/api/admin/materials/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'catalog.xlsx', dataBase64 })
      .expect(200);
    expect(imported.body).toMatchObject({ created: 2, updated: 0, total: 2 });

    const updateSheet = XLSX.utils.aoa_to_sheet([
      ['Код', 'Наименование', 'Категория', 'Ед. измерения', 'Характеристики', 'Бренд'],
      ['BLT-M8', 'Bolt M8 updated', 'Hardware', 'шт', 'M8 x 50', 'Bosch Pro'],
    ]);
    const updateBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(updateBook, updateSheet, 'Каталог');
    const updateBase64 = Buffer.from(XLSX.write(updateBook, { type: 'buffer', bookType: 'xlsx' })).toString('base64');

    const updated = await request(app).post('/api/admin/materials/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'catalog-update.xlsx', dataBase64: updateBase64 })
      .expect(200);
    expect(updated.body).toMatchObject({ created: 0, updated: 1, total: 1 });

    const list = await request(app).get('/api/admin/materials')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.find((m: { sku: string }) => m.sku === 'BLT-M8')).toMatchObject({
      name: 'Bolt M8 updated',
      category: 'Hardware',
      defaultUnit: 'шт',
      characteristics: 'M8 x 50',
      brand: 'Bosch Pro',
    });
  });
});
