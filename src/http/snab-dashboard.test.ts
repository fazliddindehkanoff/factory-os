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
    expect(sidebar).toContain('Снабжение');
    // Real, built features — not speculative stubs like the ones excluded above.
    expect(sidebar).toContain('Склады');
    expect(sidebar).toContain('Отделы');
    expect(sidebar).toContain('Номенклатура');
    expect(sidebar!.indexOf('id="navNamenklatura"')).toBeGreaterThan(sidebar!.indexOf('id="settingsGroup"'));
    expect(res.text).not.toContain('<h1>Новая заявка</h1>');
    expect(res.text).not.toContain('Все поля — на одном экране');
    expect(res.text).not.toContain('id="langToggle" type="button"><i class="ti ti-language"');
    expect(res.text).toContain('<span id="langLabel">RU</span>');
    expect(res.text).toContain('data-lang="tr" type="button">TR</button>');
    expect(res.text).toContain('<th style="width:7%;">НДС</th>');
    expect(res.text).toContain('input data-f="name" list="productTitleList"');
    expect(res.text).toContain('textarea data-f="note"');
    expect(res.text).toContain('data-create-step-indicator="1"');
    expect(res.text).toContain('data-create-step-indicator="3"');
    expect(res.text).toContain('id="createReview"');
    expect(res.text).toContain('id="createNext"');
    expect(res.text).toContain('function validateCreateStep(step)');
    expect(res.text).toContain('id="deleteAllRequests"');
    expect(res.text).toContain('data-delete-request=');
    expect(res.text).toContain('data-edit-request=');
    expect(res.text).toContain('class="request-row-actions"');
    expect(res.text).toContain('openRequest(editButton.dataset.editRequest, true)');
    expect(res.text).toContain('id="navWorkflow"');
    expect(res.text).toContain('id="viewWorkflow"');
    expect(res.text).toContain('Режим проектирования');
    expect(res.text).toContain("coreApi('/admin/workflows'");
    expect(res.text).not.toContain('Сделать активной');
    expect(res.text).toContain("coreApi('/admin/requests/delete-all', 'POST', {})");
    expect(res.text).toContain("const VIEW_PATHS = { overview:'overview'");
    expect(res.text).toContain("window.addEventListener('popstate'");
    expect(res.text).toContain("Можно создать следующую.");
    expect(res.text).toContain('id="requestEditModal"');
    expect(res.text).toContain('data-edit-current-request');
    expect(res.text).toContain("await coreApi('/requests/' + encodeURIComponent(id), 'PUT'");
    expect(res.text).toContain("toast('Заявка обновлена в dashboard и Web App')");
    expect(res.text).toContain('data-quote-payment');
    expect(res.text).toContain('data-quote-nds');
    expect(res.text).not.toContain('id="actionPayment"');
    expect(res.text).toContain('/snab-dashboard/assets/tabler-icons.min.css');
    expect(res.text).toContain('class="ti ti-layout-dashboard"');
    expect(res.text).toContain('id="procurementHost"');
    expect(res.text).toContain('id="columnFilterPopover"');
    const script = res.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(script).toContain('requesterDepartmentLabel');
    expect(script).toContain("typeof field.showPicker === 'function'");

    const createRoute = await request(app).get('/snab-dashboard/create').expect(200);
    expect(createRoute.text).toContain('id="viewCreate"');
    const workflowRoute = await request(app).get('/snab-dashboard/workflow').expect(200);
    expect(workflowRoute.text).toContain('id="viewWorkflow"');
    await request(app).get('/snab-dashboard/not-a-page').expect(404);
    await client.close();
  });

  it('gives the register and both catalogs the same spreadsheet grid controls', async () => {
    const { app, client } = await make();
    const res = await request(app).get('/snab-dashboard/').expect(200);

    // All three tables mount into a host div and get their shell from one component.
    expect(res.text).toContain('<div class="grid-host" id="procurementHost">');
    expect(res.text).toContain('<div class="grid-host" id="namenklaturaHost">');
    expect(res.text).toContain('<div class="grid-host" id="suppliersHost">');
    // No table renders its own toolbar/pager markup any more.
    expect(res.text).not.toContain('id="tablePager"');
    expect(res.text).not.toContain('id="showAllColumns"');

    const script = res.text.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script).toContain('function createDataGrid');
    expect(script).toContain("hostId: 'procurementHost'");
    expect(script).toContain("hostId: 'namenklaturaHost'");
    expect(script).toContain("hostId: 'suppliersHost'");
    // Register-only extras still ride on the shared component, but the register
    // uses the grid toolbar search instead of a navbar search.
    expect(script).not.toContain("searchInputIds: ['search', 'mobileSearch']");
    expect(script).toContain('function groupRowHtml');
    expect(script).not.toContain('data-grid-autofit=');
    expect(script).not.toContain('data-grid-reset=');
    expect(script).not.toContain('data-grid-toggle-filters');
    expect(res.text).not.toContain('id="overviewActions"');
    expect(res.text).not.toContain('id="mobileSearch"');
    // Same shell as Снабжение: filter chips, column picker, pager, single table scrollbar.
    expect(script).toContain('class="table-shell"');
    expect(script).toContain('data-grid-chips');
    expect(script).toContain('data-grid-columns-list');
    expect(script).toContain('data-grid-page-size');
    expect(script).toContain('data-grid-scroll');
    expect(script).not.toContain('data-grid-top-scroll');
    // Sorting, per-column filters, drag-resize and auto-fit are shared by every grid.
    expect(script).toContain('function autofitColumns');
    expect(script).toContain('col-resize-handle');
    expect(script).toContain('data-grid-sort=');
    expect(script).toContain('data-grid-filter=');

    // The filter popover is shared, so it must not live inside a view that gets hidden.
    expect(res.text.indexOf('id="columnFilterPopover"')).toBeGreaterThan(res.text.indexOf('id="viewWarehouses"'));
    await client.close();
  });

  it('serves the local Tabler icon stylesheet and SVG assets', async () => {
    const { app, client } = await make();
    const css = await request(app).get('/snab-dashboard/assets/tabler-icons.min.css').expect(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.text).toContain('.ti-layout-dashboard');

    const icon = await request(app).get('/snab-dashboard/assets/icons/layout-dashboard.svg').expect(200);
    expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect(Buffer.from(icon.body).toString('utf8')).toContain('<svg');
    await request(app).get('/snab-dashboard/assets/icons/not-allowed.svg').expect(404);
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

    // Dashboard and Telegram Web App use the same canonical request store/API.
    const webAppList = await request(app).get('/api/requests?limit=100').set(auth).expect(200);
    expect(webAppList.body.items).toContainEqual(expect.objectContaining({ id: createdFromDashboard.body.id }));

    await request(app)
      .put(`/api/requests/${createdFromDashboard.body.id}`)
      .set(auth)
      .send({
        title: 'Заявка изменена в dashboard',
        description: 'Общее изменение для двух интерфейсов',
        items: [{ id: createdItems[0].id, name: 'Хлопковая пряжа 40/1 — обновлено', quantity: 4, unit: 'кг' }],
      })
      .expect(200);

    const webAppDetail = await request(app).get(`/api/requests/${createdFromDashboard.body.id}`).set(auth).expect(200);
    expect(webAppDetail.body).toMatchObject({
      title: 'Заявка изменена в dashboard',
      description: 'Общее изменение для двух интерфейсов',
    });
    expect(webAppDetail.body.items[0]).toMatchObject({ name: 'Хлопковая пряжа 40/1 — обновлено', unit: 'кг' });
    expect(Number(webAppDetail.body.items[0].quantity)).toBe(4);
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
      .expect(200)
      .expect((response) => {
        expect(response.body.rows).toEqual([]);
        expect(response.body.canSeeMoney).toBe(true);
        expect(response.body.materials.some((material: any) => material.title === 'Хлопковая пряжа 40/1')).toBe(true);
      });

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

  it('returns localized requester departments and stores payment/NDS per created item', async () => {
    const { app, db, client, owner } = await make();
    const [department] = await db
      .insert(schema.departments)
      .values({ holdingId: owner.holdingId!, name: 'Supply', nameUz: 'Ta\'minot', nameTr: 'Tedarik' })
      .returning();
    await db.insert(schema.userDepartments).values({ userId: owner.id, departmentId: department.id });

    const login = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const me = await request(app).post('/snab-dashboard/api/me').set(auth).expect(200);
    expect(me.body.roleCodes).toContain('owner');

    const meta = await request(app).post('/snab-dashboard/api/meta').set(auth).send({}).expect(200);
    const requester = meta.body.users.find((user: any) => user.id === owner.id);
    expect(requester.departments).toEqual([
      { id: department.id, name: 'Supply', nameUz: 'Ta\'minot', nameTr: 'Tedarik' },
    ]);
    expect(meta.body.departments.map((item: any) => item.id)).toEqual([department.id]);

    const created = await request(app)
      .post('/api/requests')
      .set(auth)
      .send({
        departmentId: department.id,
        items: [{ name: 'Long product name', quantity: 2, unitPrice: 100, paymentType: 'Банк', ndsIncluded: true }],
      })
      .expect(201);
    const [item] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, created.body.id));
    expect(item).toMatchObject({ paymentType: 'Банк', ndsIncluded: true });

    await client.close();
  });

  it('forces a password change for an admin-assigned password, then clears the flag', async () => {
    const { app, client } = await make();
    const ownerLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${ownerLogin.body.token}` };

    // Phone-as-starting-password convenience: admin sets it, so it's untrusted
    // until the person replaces it themselves.
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth)
      .send({ fullName: 'Phone Login', phone: '+998901234500', password: '998901234500' })
      .expect(201);

    const login = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: '998901234500', password: '998901234500' })
      .expect(200);
    expect(login.body.mustChangePassword).toBe(true);
    const userAuth = { Authorization: `Bearer ${login.body.token}` };

    const me = await request(app).post('/snab-dashboard/api/me').set(userAuth).expect(200);
    expect(me.body.mustChangePassword).toBe(true);

    // Too short — rejected, flag stays set.
    await request(app).post('/snab-dashboard/api/auth/set-password').set(userAuth).send({ password: 'short' }).expect(400);

    await request(app).post('/snab-dashboard/api/auth/set-password').set(userAuth).send({ password: 'my-own-new-password' }).expect(200);
    const meAfter = await request(app).post('/snab-dashboard/api/me').set(userAuth).expect(200);
    expect(meAfter.body.mustChangePassword).toBe(false);

    // Old (admin-assigned) password no longer works; the new one does, with the flag gone.
    await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: '998901234500', password: '998901234500' })
      .expect(401);
    const relogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: '998901234500', password: 'my-own-new-password' })
      .expect(200);
    expect(relogin.body.mustChangePassword).toBe(false);

    // An admin resetting the password again re-arms the flag.
    await request(app)
      .put(`/api/admin/users/${created.body.id}`)
      .set(auth)
      .send({ password: 'admin-reset-again' })
      .expect(200);
    const afterReset = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: '998901234500', password: 'admin-reset-again' })
      .expect(200);
    expect(afterReset.body.mustChangePassword).toBe(true);

    await client.close();
  });

  it('masks amounts in the register for a dashboard user without money permissions', async () => {
    const { app, db, client, owner } = await make();
    const ownerLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);
    const auth = { Authorization: `Bearer ${ownerLogin.body.token}` };

    const [createdRequest] = await db.insert(schema.requests).values({
      requestNumber: 'SNAB-MONEY-1',
      holdingId: owner.holdingId,
      requesterId: owner.id,
      title: 'Money gate check',
      status: 'draft',
    }).returning();
    await db.insert(schema.requestItems).values({
      requestId: createdRequest.id,
      name: 'Товар',
      quantity: '1',
      unit: 'шт',
      estimatedPrice: 5000,
      totalAmount: 5000,
    });

    // Owner (money perms via procurement.view etc.) sees the real amount.
    const ownerData = await request(app).post('/snab-dashboard/api/data').set(auth).send({}).expect(200);
    expect(ownerData.body.canSeeMoney).toBe(true);
    expect(ownerData.body.rows.some((row: any) => row.amount === 5000)).toBe(true);

    // A dept_head has requests.view but none of MONEY_PERMS — must not see amounts.
    const roles = await request(app).get('/api/admin/roles').set(auth).expect(200);
    const deptHead = roles.body.find((role: any) => role.code === 'dept_head');
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth)
      .send({ fullName: 'No Money', username: 'no.money', password: 'no-money-password' })
      .expect(201);
    await request(app).post(`/api/admin/users/${created.body.id}/roles`).set(auth).send({ roleId: deptHead.id }).expect(201);

    const noMoneyLogin = await request(app)
      .post('/snab-dashboard/api/auth/login')
      .send({ username: 'no.money', password: 'no-money-password' })
      .expect(200);
    expect(noMoneyLogin.body.permissions).not.toEqual(expect.arrayContaining(['procurement.view', 'finance.view', 'audit.view']));
    const noMoneyAuth = { Authorization: `Bearer ${noMoneyLogin.body.token}` };

    const meRes = await request(app).post('/snab-dashboard/api/me').set(noMoneyAuth).expect(200);
    expect(meRes.body.canSeeMoney).toBe(false);

    const dataRes = await request(app).post('/snab-dashboard/api/data').set(noMoneyAuth).send({}).expect(200);
    expect(dataRes.body.canSeeMoney).toBe(false);
    const maskedRow = dataRes.body.rows.find((row: any) => row.requestNumber === 'SNAB-MONEY-1');
    expect(maskedRow).toBeTruthy();
    expect(maskedRow.amount).toBe(0);
    expect(maskedRow.unitPrice).toBe(0);

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
