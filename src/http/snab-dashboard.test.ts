import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import { setupTenant } from '../db/tenant-setup.js';
import { createApp } from '../server/app.js';

const SECRET = 'snab-dashboard-test-session-secret';
const USERNAME = 'snab.admin';
const PASSWORD = 'correct-horse-battery-staple';
const savedUsername = process.env.SNAB_DASHBOARD_USERNAME;
const savedPassword = process.env.SNAB_DASHBOARD_PASSWORD;

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const { owner } = await setupTenant(db, {
    holdingName: 'Snab Test Holding',
    ownerTelegramId: 'snab-owner',
    ownerName: 'Snab Owner',
  });
  const app = createApp({
    db,
    botToken: '',
    sessionSecret: SECRET,
    devAuth: false,
    rateLimit: false,
  });
  return { app, db, client, owner: owner! };
}

beforeEach(() => {
  process.env.SNAB_DASHBOARD_USERNAME = USERNAME;
  process.env.SNAB_DASHBOARD_PASSWORD = PASSWORD;
});

afterEach(() => {
  if (savedUsername === undefined) delete process.env.SNAB_DASHBOARD_USERNAME;
  else process.env.SNAB_DASHBOARD_USERNAME = savedUsername;
  if (savedPassword === undefined) delete process.env.SNAB_DASHBOARD_PASSWORD;
  else process.env.SNAB_DASHBOARD_PASSWORD = savedPassword;
});

describe('snab dashboard authentication', () => {
  it('renders accessible username and password fields', async () => {
    const { app, client } = await make();
    const res = await request(app).get('/snab-dashboard/').expect(200);

    expect(res.text).toContain('id="username"');
    expect(res.text).toContain('autocomplete="username"');
    expect(res.text).toContain('id="password"');
    expect(res.text).toContain('autocomplete="current-password"');
    const sidebar = res.text.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0];
    expect(sidebar).toBeTruthy();
    expect(sidebar).not.toContain('Документы');
    expect(sidebar).not.toContain('Отчёты');
    expect(sidebar).not.toContain('Склад');
    expect(sidebar).toContain('Снабжение');
    const script = res.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    await client.close();
  });

  it('resolves a product title and unit from its catalog code in dashboard data and edits', async () => {
    const { app, db, client, owner } = await make();
    const login = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };

    await db.insert(schema.materials).values({
      holdingId: owner.holdingId,
      name: 'Хлопковая пряжа 40/1',
      sku: 'PRY-40-1',
      defaultUnit: 'кг',
    });
    const [createdRequest] = await db.insert(schema.requests).values({
      requestNumber: 'SNAB-CATALOG-1',
      holdingId: owner.holdingId,
      requesterId: owner.id,
      title: 'Catalog lookup',
      status: 'draft',
    }).returning();
    const [item] = await db.insert(schema.requestItems).values({
      requestId: createdRequest.id,
      name: 'Неверное ручное название',
      quantity: '2',
      unit: 'шт',
      estimatedPrice: 1000,
      totalAmount: 2000,
    }).returning();

    const data = await request(app).post('/snab-dashboard/api/data').set(auth).send({}).expect(200);
    expect(data.body.materials).toContainEqual(expect.objectContaining({
      code: 'PRY-40-1',
      title: 'Хлопковая пряжа 40/1',
      unit: 'кг',
    }));

    await request(app)
      .put(`/snab-dashboard/api/row/${item.id}`)
      .set(auth)
      .send({ row: { productCode: 'pry-40-1', materialName: 'Ручное название', quantity: 2, unit: 'шт', unitPrice: 1000 } })
      .expect(200, { ok: true });

    const [stored] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.id, item.id));
    expect(stored.name).toBe('Хлопковая пряжа 40/1');
    expect(stored.unit).toBe('кг');
    expect(stored.description).toContain('Код товара: PRY-40-1');

    const createdFromDashboard = await request(app)
      .post('/snab-dashboard/api/requests')
      .set(auth)
      .send({
        requesterId: owner.id,
        requestType: 'material_request',
        items: [{ code: 'pry-40-1', name: 'Ещё одно ручное название', qty: 3, unit: 'шт', price: 500 }],
      })
      .expect(200);
    const createdItems = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, createdFromDashboard.body.id));
    expect(createdItems[0]).toMatchObject({ name: 'Хлопковая пряжа 40/1', unit: 'кг' });
    expect(createdItems[0].description).toContain('Код товара: PRY-40-1');
    await client.close();
  });

  it('rejects partial or incorrect credentials', async () => {
    const { app, client } = await make();

    await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ password: PASSWORD })
      .expect(401, { error: 'Неверное имя пользователя или пароль' });
    await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: 'wrong' })
      .expect(401, { error: 'Неверное имя пользователя или пароль' });

    await client.close();
  });

  it('bootstraps the first owner account and exchanges the password for a signed session', async () => {
    const { app, db, client, owner } = await make();
    const login = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);

    expect(login.body.token).toEqual(expect.any(String));
    expect(login.body.user).toMatchObject({ id: owner.id, username: USERNAME, fullName: 'Snab Owner' });
    expect(login.body.permissions).toContain('users.manage');

    const [stored] = await db.select().from(schema.users);
    expect(stored.username).toBe(USERNAME);
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);

    await request(app)
      .post('/snab-dashboard/api/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200)
      .expect((res) => expect(res.body.permissions).toContain('roles.manage'));
    await request(app)
      .post('/snab-dashboard/api/data')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({})
      .expect(200, { rows: [], materials: [] });

    // Once bootstrapped, login uses the stored hash and no longer depends on env credentials.
    delete process.env.SNAB_DASHBOARD_USERNAME;
    delete process.env.SNAB_DASHBOARD_PASSWORD;
    await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);

    await client.close();
  });

  it('rejects bearer access without a valid dashboard session', async () => {
    const { app, client } = await make();

    await request(app)
      .post('/snab-dashboard/api/data')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(401, { error: 'Сессия истекла — войдите снова' });
    await request(app)
      .post('/snab-dashboard/api/data')
      .set('Authorization', 'Bearer invalid')
      .send({})
      .expect(401, { error: 'Сессия истекла — войдите снова' });

    await client.close();
  });

  it('lets an owner create a shared web/Telegram user, assign a role, edit it, and control login', async () => {
    const { app, client } = await make();
    const ownerLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${ownerLogin.body.token}` };

    const roles = await request(app).get('/api/admin/roles').set(auth).expect(200);
    const requester = roles.body.find((role: any) => role.code === 'requester');
    expect(requester).toBeTruthy();

    const created = await request(app)
      .post('/api/admin/users')
      .set(auth)
      .send({
        fullName: 'Dashboard Requester',
        username: 'requester.web',
        password: 'requester-password',
        telegramId: 'tg-requester-web',
        position: 'Assistant',
      })
      .expect(201);
    expect(created.body).toMatchObject({ username: 'requester.web', telegramId: 'tg-requester-web' });
    expect(created.body.passwordHash).toBeUndefined();

    await request(app)
      .post(`/api/admin/users/${created.body.id}/roles`)
      .set(auth)
      .send({ roleId: requester.id })
      .expect(201);

    const users = await request(app).get('/api/admin/users').set(auth).expect(200);
    const listed = users.body.find((user: any) => user.id === created.body.id);
    expect(listed.username).toBe('requester.web');
    expect(listed.roles.map((role: any) => role.roleCode)).toContain('requester');

    const userLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: 'requester.web', password: 'requester-password' })
      .expect(200);
    expect(userLogin.body.permissions).toContain('requests.create');

    await request(app)
      .put(`/api/admin/users/${created.body.id}`)
      .set(auth)
      .send({ fullName: 'Updated Requester', status: 'disabled' })
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ fullName: 'Updated Requester', status: 'disabled' }));
    await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: 'requester.web', password: 'requester-password' })
      .expect(401);

    await client.close();
  });

  it('supports own-request visibility roles and dashboard role deletion', async () => {
    const { app, db, client, owner } = await make();
    const ownerLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${ownerLogin.body.token}` };

    const permissions = await request(app).get('/api/admin/permissions').set(auth).expect(200);
    expect(permissions.body.map((permission: any) => permission.code)).toContain('requests.view_own');

    const ownRole = await request(app)
      .post('/api/admin/roles')
      .set(auth)
      .send({ name: 'Own Request Viewer', code: 'own_request_viewer' })
      .expect(201);
    await request(app)
      .put(`/api/admin/roles/${ownRole.body.id}/permissions`)
      .set(auth)
      .send({ codes: ['requests.view_own'] })
      .expect(200);

    const user = await request(app)
      .post('/api/admin/users')
      .set(auth)
      .send({
        fullName: 'Own Only User',
        username: 'own.only',
        password: 'own-only-password',
        telegramId: 'tg-own-only',
        position: 'Requester',
      })
      .expect(201);
    await request(app)
      .post(`/api/admin/users/${user.body.id}/roles`)
      .set(auth)
      .send({ roleId: ownRole.body.id })
      .expect(201);

    const [ownRequest] = await db.insert(schema.requests).values({
      requestNumber: 'SNAB-OWN-1',
      holdingId: owner.holdingId,
      requesterId: user.body.id,
      title: 'Visible own request',
      status: 'draft',
    }).returning();
    await db.insert(schema.requestItems).values({
      requestId: ownRequest.id,
      name: 'Own material',
      quantity: '2',
      unit: 'pcs',
      estimatedPrice: 1000,
      totalAmount: 2000,
    });

    const [otherRequest] = await db.insert(schema.requests).values({
      requestNumber: 'SNAB-OTHER-1',
      holdingId: owner.holdingId,
      requesterId: owner.id,
      title: 'Hidden other request',
      status: 'draft',
    }).returning();
    await db.insert(schema.requestItems).values({
      requestId: otherRequest.id,
      name: 'Other material',
      quantity: '1',
      unit: 'pcs',
      estimatedPrice: 3000,
      totalAmount: 3000,
    });

    const ownLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: 'own.only', password: 'own-only-password' })
      .expect(200);
    expect(ownLogin.body.permissions).toContain('requests.view_own');
    expect(ownLogin.body.permissions).not.toContain('requests.view');

    const dashboardRows = await request(app)
      .post('/snab-dashboard/api/data')
      .set('Authorization', `Bearer ${ownLogin.body.token}`)
      .send({})
      .expect(200);
    expect(dashboardRows.body.rows.map((row: any) => row.requestNumber)).toEqual(['SNAB-OWN-1']);

    const listRows = await request(app)
      .get('/api/requests?limit=200')
      .set('Authorization', `Bearer ${ownLogin.body.token}`)
      .expect(200);
    expect(listRows.body.items.map((row: any) => row.requestNumber)).toEqual(['SNAB-OWN-1']);

    const tempRole = await request(app)
      .post('/api/admin/roles')
      .set(auth)
      .send({ name: 'Temporary Role', code: 'temporary_delete_role' })
      .expect(201);
    await request(app)
      .put(`/api/admin/roles/${tempRole.body.id}`)
      .set(auth)
      .send({ name: 'Temporary Role Renamed' })
      .expect(200)
      .expect((res) => expect(res.body.name).toBe('Temporary Role Renamed'));
    await request(app).delete(`/api/admin/roles/${tempRole.body.id}`).set(auth).expect(200);

    await client.close();
  });
});
