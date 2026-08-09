import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
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
  const dcs = [...p.keys()]
    .sort()
    .map((k) => `${k}=${p.get(k)}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

async function makeApp(devAuth = false) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return { app: createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth, rateLimit: false }), db };
}

// Auth is fail-closed: /api/auth/telegram only succeeds for an already-provisioned
// telegramId (an admin invite, or — in production — the bot's phone-share flow).
async function provisionTelegramUser(db: any, id: number, fullName = 'T'): Promise<void> {
  await db.insert(schema.users).values({ telegramId: String(id), fullName, status: 'pending' });
}

async function systemRoleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

describe('HTTP API', () => {
  it('returns 401 for unauthenticated access', async () => {
    const { app } = await makeApp();
    await request(app).get('/api/requests').expect(401);
  });

  it('logs in via initData and serves /me with a Bearer token', async () => {
    const { app, db } = await makeApp();
    await provisionTelegramUser(db, 42);
    const login = await request(app)
      .post('/api/auth/telegram')
      .send({ initData: initData(42) })
      .expect(200);
    expect(login.body.token).toBeTruthy();
    // Provisioned users start 'pending'; approve to active so they can use the API.
    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, login.body.user.id));

    const me = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.user.id).toBe(login.body.user.id);
    expect(me.body.permissions).toEqual([]); // no tenant/role yet
  });

  it('rejects invalid initData at login', async () => {
    const { app } = await makeApp();
    await request(app).post('/api/auth/telegram').send({ initData: 'garbage' }).expect(401);
  });

  it('rejects initData for a telegram id no admin has provisioned (fail-closed)', async () => {
    const { app } = await makeApp();
    await request(app).post('/api/auth/telegram').send({ initData: initData(999) }).expect(403);
  });

  it('dev login is 404 when disabled and issues a token when enabled', async () => {
    const off = await makeApp(false);
    await request(off.app).post('/api/auth/dev').send({ telegramId: '1' }).expect(404);

    const on = await makeApp(true);
    const res = await request(on.app).post('/api/auth/dev').send({ telegramId: '1' }).expect(200);
    expect(res.body.token).toBeTruthy();
    await request(on.app)
      .get('/api/me')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
  });

  it('creates and lists a request for a tenant-assigned user, end to end', async () => {
    const { app, db } = await makeApp();

    // Tenant setup: holding + a default workflow with a dept_head step.
    const [h] = await db.insert(schema.holdings).values({ name: 'Zelal' }).returning();
    const [wf] = await db
      .insert(schema.workflows)
      .values({ holdingId: h.id, name: 'Default', isActive: true })
      .returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id,
      stepOrder: 1,
      stepName: 'Рук. отдела',
      approverRoleId: await systemRoleId(db, 'dept_head'),
    });

    // Login, then assign the user to the holding with the requester role.
    await provisionTelegramUser(db, 7);
    const login = await request(app)
      .post('/api/auth/telegram')
      .send({ initData: initData(7) })
      .expect(200);
    const token = login.body.token as string;
    const userId = login.body.user.id as string;
    await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
    await db.insert(schema.userRoles).values({
      userId,
      roleId: await systemRoleId(db, 'requester'),
      holdingId: h.id,
    });
    const [selectedRequester] = await db.insert(schema.users).values({
      holdingId: h.id,
      fullName: 'Selected requester',
      status: 'active',
    }).returning();
    const [creatorDepartment, selectedDepartment] = await db.insert(schema.departments).values([
      { holdingId: h.id, name: 'Creator department' },
      { holdingId: h.id, name: 'Selected department' },
    ]).returning();
    await db.insert(schema.userDepartments).values([
      { userId, departmentId: creatorDepartment.id },
      { userId: selectedRequester.id, departmentId: selectedDepartment.id },
    ]);

    const config = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(config.body.departments.map((department: { id: string }) => department.id)).toEqual(
      expect.arrayContaining([creatorDepartment.id, selectedDepartment.id]),
    );
    expect(config.body.users.find((user: { id: string }) => user.id === selectedRequester.id).departmentId)
      .toBe(selectedDepartment.id);

    // Create a request through the API.
    const created = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        requesterId: selectedRequester.id,
        items: [
          { name: 'Cotton', quantity: 2, unitPrice: 1000 },
          { name: 'Dye', quantity: 1, unitPrice: 500 },
        ],
      })
      .expect(201);
    expect(created.body.status).toBe('pending_approval');
    expect(created.body.estimatedAmount).toBe(2500);
    const [storedRequest] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.body.id));
    expect(storedRequest.requesterId).toBe(selectedRequester.id);
    const [creationAudit] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, created.body.id));
    expect(creationAudit.userId).toBe(userId);
    const storedItems = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, created.body.id));
    expect(storedItems.map((it) => it.name).sort()).toEqual(['Cotton', 'Dye']);

    // It shows up in the list.
    const list = await request(app)
      .get('/api/requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].requestNumber).toMatch(/^REQ-\d{4}-00001$/);
  });

  it('forbids creating a request without the requests.create permission', async () => {
    const { app, db } = await makeApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    await provisionTelegramUser(db, 9);
    const login = await request(app)
      .post('/api/auth/telegram')
      .send({ initData: initData(9) })
      .expect(200);
    const token = login.body.token as string;
    // Assign to holding but with NO role → default-deny.
    await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, login.body.user.id));
    await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ name: 'X', quantity: 1, unitPrice: 1 }] })
      .expect(403);
  });
});
