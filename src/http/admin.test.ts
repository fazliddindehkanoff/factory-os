import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setupTenant } from '../db/tenant-setup.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const { holding } = await setupTenant(db, { holdingName: 'Zelal', ownerTelegramId: '999', ownerName: 'Owner', seedDemoUsers: true });
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  return { app, db, holding };
}

async function login(app: any, telegramId: string): Promise<string> {
  const res = await request(app).post('/api/auth/dev').send({ telegramId }).expect(200);
  return res.body.token as string;
}
async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

describe('constructor / admin API', () => {
  it('owner can read catalog, create a role, set its permissions and assign it', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');

    const perms = await request(app).get('/api/admin/permissions').set('Authorization', `Bearer ${token}`).expect(200);
    expect(perms.body.length).toBe(28); // +materials.manage (namenklatura edit rights, decoupled from settings.manage)

    const roles = await request(app).get('/api/admin/roles').set('Authorization', `Bearer ${token}`).expect(200);
    expect(roles.body.some((r: any) => r.code === 'owner')).toBe(true);

    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'buyer', name: 'Закупщик' })
      .expect(201);
    const newRoleId = created.body.id;

    await request(app)
      .put(`/api/admin/roles/${newRoleId}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['requests.view', 'procurement.view'] })
      .expect(200);
    await request(app)
      .put(`/api/admin/roles/${newRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Старший закупщик' })
      .expect(200);

    // A fresh user assigned the new role.
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Buyer', telegramId: 'b1' })
      .returning();
    await request(app)
      .post(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: newRoleId })
      .expect(201);

    const users = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`).expect(200);
    const row = users.body.find((x: any) => x.id === target.id);
    expect(row.roles.some((rr: any) => rr.roleCode === 'buyer')).toBe(true);

    const disposable = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'temp_role', name: 'Временная роль' })
      .expect(201);
    await request(app)
      .delete(`/api/admin/roles/${disposable.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('creates a phone-only user with no username/password — bot-only staff need neither', async () => {
    const { app } = await make();
    const token = await login(app, '999');
    const created = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Phone Only', phone: '+998 90 111 22 33' })
      .expect(201);
    // Username auto-derives from the normalized phone so the bot's contact-share
    // flow (matching on `phone`) and any future dashboard login both resolve to
    // the same account, with no password set (can't log into the dashboard).
    expect(created.body.username).toBe('998901112233');
    expect(created.body.phone).toBe('998901112233');
    expect(created.body.passwordHash).toBeUndefined();

    // No identity at all (no phone/username/telegramId) is still rejected.
    await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Nobody' })
      .expect(400);
  });

  it('manages multilingual positions and assigns a warehouse responsible employee', async () => {
    const { app } = await make();
    const token = await login(app, '999');
    const auth = { Authorization: `Bearer ${token}` };
    const position = await request(app).post('/api/admin/positions').set(auth)
      .send({ nameRu: 'Кладовщик', nameUz: 'Omborchi', nameTr: 'Depocu' }).expect(201);
    const employee = await request(app).post('/api/admin/users').set(auth)
      .send({ fullName: 'Warehouse Responsible', phone: '998901234500', positionId: position.body.id }).expect(201);
    expect(employee.body.positionId).toBe(position.body.id);
    expect(employee.body.position).toBe('Кладовщик');

    const warehouse = await request(app).post('/api/admin/warehouses').set(auth)
      .send({ name: 'Склад тест', nameUz: 'Sinov ombori', nameTr: 'Test deposu', responsibleUserId: employee.body.id }).expect(201);
    const warehouses = await request(app).get('/api/admin/warehouses').set(auth).expect(200);
    expect(warehouses.body.find((w: any) => w.id === warehouse.body.id)).toMatchObject({
      responsibleUserId: employee.body.id,
      responsibleUserName: 'Warehouse Responsible',
    });
  });

  it('lets roles.manage users read roles but only owner can mutate role definitions', async () => {
    const { app, db, holding } = await make();

    // A limited admin: only roles.manage (via a custom role), NOT finance.mark_paid.
    const [limited] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Limited', telegramId: 'lim1', status: 'active' })
      .returning();
    const [limitedRole] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'role_admin_only', name: 'Только роли', isSystem: false })
      .returning();
    const [permRow] = await db
      .select()
      .from(schema.permissions)
      .where(eq(schema.permissions.code, 'roles.manage'));
    await db.insert(schema.rolePermissions).values({ roleId: limitedRole.id, permissionId: permRow.id });
    await db.insert(schema.userRoles).values({ userId: limited.id, roleId: limitedRole.id, holdingId: holding.id });

    const token = await login(app, 'lim1');
    await request(app).get('/api/admin/roles').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'x', name: 'X' })
      .expect(403);

    const [targetRole] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'x', name: 'X', isSystem: false })
      .returning();
    await request(app)
      .put(`/api/admin/roles/${targetRole.id}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['requests.view'] })
      .expect(403);
    await request(app)
      .put(`/api/admin/roles/${targetRole.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Y' })
      .expect(403);
    await request(app)
      .delete(`/api/admin/roles/${targetRole.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // And cannot assign the powerful system owner role either.
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'T', telegramId: 't9' })
      .returning();
    await request(app)
      .post(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: await roleId(db, 'owner') })
      .expect(403);
  });

  it('config reflects tenant settings, and editing settings via admin updates it', async () => {
    const { app, db, holding } = await make(); // setupTenant sets factory_name='Zelal' and a nine-step workflow
    const token = await login(app, '999');
    const [dept] = await db
      .insert(schema.departments)
      .values({ holdingId: holding.id, name: 'Production', nameUz: 'Ishlab chiqarish', nameTr: 'Uretim' })
      .returning();
    const [member] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Department User', telegramId: 'dept-user', status: 'active' })
      .returning();
    await db.insert(schema.userDepartments).values({ userId: member.id, departmentId: dept.id });

    const cfg = await request(app).get('/api/config').set('Authorization', `Bearer ${token}`).expect(200);
    expect(cfg.body.factoryName).toBe('Zelal');
    expect(cfg.body.stages.length).toBe(10);
    const cfgUser = cfg.body.users.find((u: any) => u.id === member.id);
    expect(cfgUser.departmentId).toBe(dept.id);
    expect(cfgUser.departments).toEqual([
      { id: dept.id, name: 'Production', nameUz: 'Ishlab chiqarish', nameTr: 'Uretim' },
    ]);

    await request(app)
      .put('/api/admin/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ factory_name: 'Новый завод' })
      .expect(200);

    const cfg2 = await request(app).get('/api/config').set('Authorization', `Bearer ${token}`).expect(200);
    expect(cfg2.body.factoryName).toBe('Новый завод');
  });

  it('denies admin endpoints to users without the manage permissions', async () => {
    const { app, db, holding } = await make();
    const [plain] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Plain', telegramId: 'p1', status: 'active' })
      .returning();
    await db.insert(schema.userRoles).values({ userId: plain.id, roleId: await roleId(db, 'requester'), holdingId: holding.id });
    const token = await login(app, 'p1');
    await request(app).get('/api/admin/roles').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('lets only the owner soft-delete requests and hides them from normal request APIs', async () => {
    const { app, db } = await make();
    const ownerToken = await login(app, '999');
    const requesterToken = await login(app, 'demo_requester');
    const created = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({ title: 'Soft delete me', items: [{ name: 'Product', quantity: 1, unitPrice: 0 }] })
      .expect(201);

    await request(app).get('/api/admin/requests').set('Authorization', `Bearer ${requesterToken}`).expect(403);
    const before = await request(app).get('/api/admin/requests').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(before.body.some((row: any) => row.id === created.body.id)).toBe(true);

    await request(app)
      .delete(`/api/admin/requests/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const [stored] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.body.id));
    expect(stored.status).toBe('deleted');
    expect(stored.currentStepId).toBeNull();
    const history = await db.select().from(schema.requestStatusHistory).where(eq(schema.requestStatusHistory.requestId, created.body.id));
    expect(history.some((row: any) => row.newStatus === 'deleted')).toBe(true);

    const list = await request(app).get('/api/requests').set('Authorization', `Bearer ${requesterToken}`).expect(200);
    expect(list.body.items.some((row: any) => row.id === created.body.id)).toBe(false);
    await request(app).get(`/api/requests/${created.body.id}`).set('Authorization', `Bearer ${requesterToken}`).expect(404);
  });

  it('searches request nomenclature by localized product title and preserves the material link', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, 'demo_requester');
    const [material] = await db.insert(schema.materials).values({
      holdingId: holding.id,
      sku: 'MAT-42',
      name: 'Хлопковая пряжа',
      nameUz: 'Paxta ipi',
      nameTr: 'Pamuk ipliği',
      defaultUnit: 'кг',
    }).returning();

    const found = await request(app)
      .get('/api/materials?search=Paxta')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(found.body).toEqual([expect.objectContaining({ id: material.id, sku: 'MAT-42' })]);

    const created = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Paxta ipi', items: [{ materialId: material.id, name: 'Paxta ipi', quantity: 2, unitPrice: 0, unit: 'кг' }] })
      .expect(201);
    const [item] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, created.body.id));
    expect(item.materialId).toBe(material.id);
  });
});

describe('admin: structure (Block A)', () => {
  it('overview returns holding counts', async () => {
    const { app } = await make();
    const token = await login(app, '999');
    const ov = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${token}`).expect(200);
    expect(ov.body.factories).toBe(1);
    expect(ov.body.warehouses).toBe(1);
    expect(ov.body.departments).toBe(0);
    expect(ov.body.activeRequests).toBe(0);
    expect(ov.body.roles).toBeGreaterThanOrEqual(8);
  });

  it('create / rename / soft-delete a department; it appears then disappears in the tree', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [factory] = await db.select().from(schema.factories).where(eq(schema.factories.holdingId, holding.id));

    const created = await request(app)
      .post('/api/admin/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Цех №1', factory_id: factory.id })
      .expect(201);
    const deptId = created.body.id;

    let tree = await request(app).get('/api/admin/structure').set('Authorization', `Bearer ${token}`).expect(200);
    let f = tree.body.factories.find((x: any) => x.id === factory.id);
    expect(f.departments.some((d: any) => d.id === deptId)).toBe(true);

    await request(app)
      .put(`/api/admin/departments/${deptId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Цех №2' })
      .expect(200);

    await request(app).delete(`/api/admin/departments/${deptId}`).set('Authorization', `Bearer ${token}`).expect(200);
    tree = await request(app).get('/api/admin/structure').set('Authorization', `Bearer ${token}`).expect(200);
    f = tree.body.factories.find((x: any) => x.id === factory.id);
    expect(f.departments.some((d: any) => d.id === deptId)).toBe(false);
  });

  it('refuses a department under a factory from another holding (404)', async () => {
    const { app, db } = await make();
    // A second holding in the same db gives us a factory id the actor must not touch.
    const other = await setupTenant(db, { holdingName: 'Other Co' });
    const token = await login(app, '999');
    await request(app)
      .post('/api/admin/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', factory_id: other.factory.id })
      .expect(404);
  });

  it('lists users of a department by their active role-assignment scope', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [factory] = await db.select().from(schema.factories).where(eq(schema.factories.holdingId, holding.id));
    const created = await request(app)
      .post('/api/admin/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Снабжение', factory_id: factory.id })
      .expect(201);
    const deptId = created.body.id;
    const [member] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Member', telegramId: 'mem1' })
      .returning();
    await request(app)
      .post(`/api/admin/users/${member.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: await roleId(db, 'requester'), departmentId: deptId })
      .expect(201);
    const list = await request(app)
      .get(`/api/admin/departments/${deptId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((x: any) => x.id === member.id)).toBe(true);
  });
});

describe('admin: people (Block B)', () => {
  it('invite creates a new user, and reactivates/attaches an existing one', async () => {
    const { app, holding } = await make();
    const token = await login(app, '999');
    const inv = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ telegram_id: 'newguy', name: 'New Guy' })
      .expect(201);
    expect(inv.body.holdingId).toBe(holding.id);
    expect(inv.body.status).toBe('active');
    expect(inv.body.fullName).toBe('New Guy');
    // existing demo user already in this holding → 200, and the admin-entered name wins
    const re = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ telegram_id: 'demo_requester', name: 'X' })
      .expect(200);
    expect(re.body.fullName).toBe('X');
  });

  it('invite of a user owned by another holding → 409', async () => {
    const { app, db } = await make();
    await setupTenant(db, { holdingName: 'Other Co', ownerTelegramId: '888', ownerName: 'Other Owner' });
    const token = await login(app, '999');
    await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ telegram_id: '888', name: 'Steal' })
      .expect(409);
  });

  it('archiving a user: never hard-deletes, revokes roles, hides from list, blocks login; cannot delete self', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'T', telegramId: 'tt1', status: 'active' })
      .returning();
    await db
      .insert(schema.userRoles)
      .values({ userId: target.id, roleId: await roleId(db, 'requester'), holdingId: holding.id });

    // While active, the user can use the API.
    const targetTk = await login(app, 'tt1');
    await request(app).get('/api/me').set('Authorization', `Bearer ${targetTk}`).expect(200);

    // "Delete" archives — never hard-deletes.
    const del = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(del.body.archived).toBe(true);

    // Row preserved, status archived, active role assignments revoked.
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(row.status).toBe('archived');
    const stillActive = await db
      .select()
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, target.id), eq(schema.userRoles.status, 'active')));
    expect(stillActive.length).toBe(0);

    // Audit event user.archived recorded.
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, 'user.archived'), eq(schema.auditLogs.entityId, target.id)));
    expect(audits.length).toBe(1);

    // Excluded from the active users list.
    const list = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.some((x: { id: string }) => x.id === target.id)).toBe(false);

    // Archived user can no longer authenticate.
    await request(app).get('/api/me').set('Authorization', `Bearer ${targetTk}`).expect(401);

    // Cannot delete self.
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).delete(`/api/admin/users/${me.body.user.id}`).set('Authorization', `Bearer ${token}`).expect(400);
  });

  it('archives even a referenced user, keeping the reference intact (no hard-delete)', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Ref', telegramId: 'tt2', status: 'active' })
      .returning();
    // A history row that references the user — a hard delete would violate this FK.
    await db
      .insert(schema.auditLogs)
      .values({ holdingId: holding.id, userId: target.id, action: 'request.created', module: 'requests' });

    await request(app).delete(`/api/admin/users/${target.id}`).set('Authorization', `Bearer ${token}`).expect(200);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(row.status).toBe('archived');
    const refs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, target.id));
    expect(refs.length).toBeGreaterThan(0); // history preserved
  });

  it('lists and revokes a user role assignment', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'R', telegramId: 'rr1' })
      .returning();
    const rid = await roleId(db, 'requester');
    await request(app)
      .post(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: rid })
      .expect(201);
    const got = await request(app)
      .get(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(got.body.some((x: any) => x.roleCode === 'requester')).toBe(true);
    // Снятие — точечно по назначению (единственный канонический способ; массовый
    // DELETE /roles/:roleId удалён как невызываемый дубль).
    const assignmentId = got.body.find((x: any) => x.roleCode === 'requester').assignmentId;
    await request(app)
      .delete(`/api/admin/users/${target.id}/assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after = await request(app)
      .get(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.length).toBe(0);
  });

  it('refuses to revoke the last owner assignment in a holding — even the owner acting on themselves', async () => {
    const { app, db } = await make();
    const token = await login(app, '999');
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
    // make() seeds a demo_owner account too (seedDemoUsers: true) — revoke its
    // owner assignment so '999' is genuinely the sole owner for this test.
    const [demoOwner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, 'demo_owner'));
    await db.update(schema.userRoles).set({ status: 'revoked' }).where(eq(schema.userRoles.userId, demoOwner.id));
    const ownerRoles = await request(app)
      .get(`/api/admin/users/${owner.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const assignmentId = ownerRoles.body.find((x: any) => x.roleCode === 'owner').assignmentId;
    const res = await request(app)
      .delete(`/api/admin/users/${owner.id}/assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(res.body.error).toMatch(/последнего учредителя/);
    // Still active — the holding didn't lose its only owner.
    const stillOwner = await request(app)
      .get(`/api/admin/users/${owner.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(stillOwner.body.some((x: any) => x.roleCode === 'owner')).toBe(true);
  });

  it('refuses to archive a user holding the last owner assignment', async () => {
    const { app, db, holding } = await make();
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
    // make() seeds a demo_owner account too (seedDemoUsers: true) — revoke its
    // owner assignment so '999' is genuinely the sole owner for this test.
    const [demoOwner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, 'demo_owner'));
    await db.update(schema.userRoles).set({ status: 'revoked' }).where(eq(schema.userRoles.userId, demoOwner.id));

    // A second actor with equivalent (all-permission) rights via a custom role,
    // so they can outrank the owner without literally holding the 'owner' role.
    const [second] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Second', telegramId: 'owner2', status: 'active' })
      .returning();
    const [allPermsRole] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'god_mode', name: 'Всё', isSystem: false })
      .returning();
    const allPerms = await db.select({ id: schema.permissions.id }).from(schema.permissions);
    await db.insert(schema.rolePermissions).values(allPerms.map((p: any) => ({ roleId: allPermsRole.id, permissionId: p.id })));
    await db.insert(schema.userRoles).values({ userId: second.id, roleId: allPermsRole.id, holdingId: holding.id });

    const secondToken = await login(app, 'owner2');
    const res = await request(app)
      .delete(`/api/admin/users/${owner.id}`)
      .set('Authorization', `Bearer ${secondToken}`)
      .expect(400);
    expect(res.body.error).toMatch(/последнего учредителя/);
  });
});

describe('admin: roles (Block C)', () => {
  it('renames a custom role but refuses to rename a system role', async () => {
    const { app, db } = await make();
    const token = await login(app, '999');
    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'c1', name: 'Custom' })
      .expect(201);
    await request(app)
      .put(`/api/admin/roles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed' })
      .expect(200);
    await request(app)
      .put(`/api/admin/roles/${await roleId(db, 'owner')}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked' })
      .expect(403);
  });

  it('deletes an unused custom role; blocks deleting a system role or one in use', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'c2', name: 'Temp' })
      .expect(201);
    await request(app)
      .delete(`/api/admin/roles/${await roleId(db, 'owner')}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'U', telegramId: 'uu1' })
      .returning();
    await db.insert(schema.userRoles).values({ userId: target.id, roleId: created.body.id, holdingId: holding.id });
    await request(app).delete(`/api/admin/roles/${created.body.id}`).set('Authorization', `Bearer ${token}`).expect(409);
    await db.update(schema.userRoles).set({ status: 'revoked' }).where(eq(schema.userRoles.roleId, created.body.id));
    await request(app).delete(`/api/admin/roles/${created.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('lets owner customize permissions of a built-in role for this holding only', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const systemOwnerId = await roleId(db, 'owner');
    const globalBefore = await db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(eq(schema.rolePermissions.roleId, systemOwnerId));
    const changed = await request(app)
      .put(`/api/admin/roles/${systemOwnerId}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['roles.manage', 'requests.view'] })
      .expect(200);

    expect(changed.body.roleId).not.toBe(systemOwnerId);
    const listed = await request(app).get('/api/admin/roles').set('Authorization', `Bearer ${token}`).expect(200);
    const ownerRole = listed.body.find((role: any) => role.code === 'owner');
    expect(ownerRole).toMatchObject({ id: changed.body.roleId, isSystem: true });
    expect(ownerRole.permissions.sort()).toEqual(['requests.view', 'roles.manage']);

    const globalAfter = await db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(eq(schema.rolePermissions.roleId, systemOwnerId));
    expect(globalAfter.map((row: { code: string }) => row.code).sort()).toEqual(globalBefore.map((row: { code: string }) => row.code).sort());
    const tenantOwnerAssignments = await db
      .select({ roleId: schema.userRoles.roleId })
      .from(schema.userRoles)
      .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
      .where(and(eq(schema.users.holdingId, holding.id), eq(schema.userRoles.status, 'active')));
    expect(tenantOwnerAssignments.some((assignment: { roleId: string }) => assignment.roleId === changed.body.roleId)).toBe(true);
  });
});

describe('admin: workflow (Block D)', () => {
  it('creates an inactive workflow, then activating it deactivates the previous active one', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const wf = await request(app)
      .post('/api/admin/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Новая цепочка' })
      .expect(201);
    expect(wf.body.isActive).toBe(false);
    // Must add at least one step before activating (CRIT-08 guard)
    await request(app)
      .post(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Согласование', step_kind: 'approval', order_index: 1 })
      .expect(201);
    await request(app)
      .put(`/api/admin/workflows/${wf.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: true })
      .expect(200);
    const actives = await db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.isActive, true)));
    expect(actives.length).toBe(1);
    expect(actives[0].id).toBe(wf.body.id);
  });

  it('adds, edits, reorders and deletes steps on a workflow with no in-flight requests', async () => {
    const { app, db } = await make();
    const token = await login(app, '999');
    const wf = await request(app)
      .post('/api/admin/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'WF' })
      .expect(201);
    const fin = await roleId(db, 'finance');
    const s1 = await request(app)
      .post(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Шаг 1', approver_role_id: fin, order_index: 1, threshold_amount: 5000000 })
      .expect(201);
    const s2 = await request(app)
      .post(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Шаг 2', approver_role_id: fin, order_index: 2 })
      .expect(201);
    await request(app)
      .put(`/api/admin/workflows/${wf.body.id}/steps/${s1.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Шаг 1*' })
      .expect(200);
    await request(app)
      .put(`/api/admin/workflows/${wf.body.id}/steps/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send([
        { id: s1.body.id, order_index: 2 },
        { id: s2.body.id, order_index: 1 },
      ])
      .expect(200);
    // Шаги читаются из GET /workflows (отдельный GET /steps удалён как дубль).
    const wfs = await request(app).get('/api/admin/workflows').set('Authorization', `Bearer ${token}`).expect(200);
    const steps = wfs.body.find((w: any) => w.id === wf.body.id).steps;
    expect(steps[0].id).toBe(s2.body.id);
    await request(app)
      .delete(`/api/admin/workflows/${wf.body.id}/steps/${s1.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const wfs2 = await request(app).get('/api/admin/workflows').set('Authorization', `Bearer ${token}`).expect(200);
    expect(wfs2.body.find((w: any) => w.id === wf.body.id).steps.length).toBe(1);
  });

  it('blocks step changes while the chain has in-flight requests (Г2)', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', items: [{ name: 'M', quantity: 1, unitPrice: 1000 }] })
      .expect(201);
    const [wf] = await db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.isActive, true)));
    await request(app)
      .post(`/api/admin/workflows/${wf.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Late', approver_role_id: await roleId(db, 'finance'), order_index: 9 })
      .expect(409);
  });
});

describe('admin: hardening (review fixes)', () => {
  it('scope-aware anti-escalation: cannot grant a permission at a broader/other scope than held', async () => {
    const { app, db, holding } = await make();
    const [factA] = await db.select().from(schema.factories).where(eq(schema.factories.holdingId, holding.id));
    const [factB] = await db
      .insert(schema.factories)
      .values({ holdingId: holding.id, name: 'Factory B' })
      .returning();

    // Admin: users.manage HOLDING-wide, but warehouse.receive only at Factory A.
    const [admin] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'ScopedAdmin', telegramId: 'sa1', status: 'active' })
      .returning();
    const [umRole] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'um', name: 'UM', isSystem: false })
      .returning();
    const [umPerm] = await db.select().from(schema.permissions).where(eq(schema.permissions.code, 'users.manage'));
    await db.insert(schema.rolePermissions).values({ roleId: umRole.id, permissionId: umPerm.id });
    await db.insert(schema.userRoles).values({ userId: admin.id, roleId: umRole.id, holdingId: holding.id });

    const [whRole] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'whr', name: 'WHR', isSystem: false })
      .returning();
    const [whPerm] = await db
      .select()
      .from(schema.permissions)
      .where(eq(schema.permissions.code, 'warehouse.receive'));
    await db.insert(schema.rolePermissions).values({ roleId: whRole.id, permissionId: whPerm.id });
    await db
      .insert(schema.userRoles)
      .values({ userId: admin.id, roleId: whRole.id, holdingId: holding.id, factoryId: factA.id });

    const token = await login(app, 'sa1');
    const [victim] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'V', telegramId: 'v1' })
      .returning();

    // Holding-wide grant (no factory) → broader than the actor holds → 403.
    await request(app)
      .post(`/api/admin/users/${victim.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: whRole.id })
      .expect(403);
    // Grant at Factory B (where the actor has no rights) → 403.
    await request(app)
      .post(`/api/admin/users/${victim.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: whRole.id, factoryId: factB.id })
      .expect(403);
    // Grant at Factory A (exactly where the actor holds it) → 201.
    await request(app)
      .post(`/api/admin/users/${victim.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: whRole.id, factoryId: factA.id })
      .expect(201);
  });

  it('a draft bound to a workflow does not block step edits (only live requests do)', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const wf = await request(app)
      .post('/api/admin/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'D' })
      .expect(201);
    const [requester] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
    await db.insert(schema.requests).values({
      requestNumber: 'REQ-2026-09999',
      holdingId: holding.id,
      requesterId: requester.id,
      status: 'draft',
      workflowId: wf.body.id,
    });
    await request(app)
      .post(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'S', approver_role_id: await roleId(db, 'finance'), order_index: 1 })
      .expect(201);
  });

  it('refuses to delete a role still used as a workflow step approver (409)', async () => {
    const { app } = await make();
    const token = await login(app, '999');
    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'appr', name: 'Appr' })
      .expect(201);
    const wf = await request(app)
      .post('/api/admin/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'W' })
      .expect(201);
    await request(app)
      .post(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'S', approver_role_id: created.body.id, order_index: 1 })
      .expect(201);
    await request(app).delete(`/api/admin/roles/${created.body.id}`).set('Authorization', `Bearer ${token}`).expect(409);
  });

  it('invite writes an audit record', async () => {
    const { app, db } = await make();
    const token = await login(app, '999');
    await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ telegram_id: 'audited', name: 'Audited' })
      .expect(201);
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'user.invited'));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('admin: frontend-review fixes', () => {
  it('revokes a single assignment by id without touching the same role at another scope', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [factA] = await db.select().from(schema.factories).where(eq(schema.factories.holdingId, holding.id));
    const [factB] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'FB' }).returning();
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'M', telegramId: 'mm9' })
      .returning();
    const rid = await roleId(db, 'requester');
    const aA = await request(app)
      .post(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: rid, factoryId: factA.id })
      .expect(201);
    await request(app)
      .post(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: rid, factoryId: factB.id })
      .expect(201);

    await request(app)
      .delete(`/api/admin/users/${target.id}/assignments/${aA.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const remaining = await request(app)
      .get(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(remaining.body.length).toBe(1);
    expect(remaining.body[0].factoryId).toBe(factB.id);
  });

  it('assigning the same role + scope twice is idempotent (no duplicate)', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');
    const [target] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'D', telegramId: 'dd9' })
      .returning();
    const rid = await roleId(db, 'requester');
    await request(app).post(`/api/admin/users/${target.id}/roles`).set('Authorization', `Bearer ${token}`).send({ roleId: rid }).expect(201);
    await request(app).post(`/api/admin/users/${target.id}/roles`).set('Authorization', `Bearer ${token}`).send({ roleId: rid }).expect(200);
    const roles = await request(app)
      .get(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(roles.body.filter((r: { roleId: string }) => r.roleId === rid).length).toBe(1);
  });
});

describe('admin: предупреждения о «мёртвых» шагах маршрута (А3, 2026-07-06)', () => {
  it('шаг с ролью без прав и без пользователей получает roleWarnings; после выдачи прав и назначения — чисто', async () => {
    const { app, db, holding } = await make();
    const token = await login(app, '999');

    // Кастомная роль без единого права (кейс «Исп дир» на проде).
    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'exec_dir', name: 'Исп дир' })
      .expect(201);
    const rid = created.body.id;

    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W-warn', isActive: false }).returning();
    await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Исп дир', stepKind: 'approval', approverRoleId: rid });

    let res = await request(app).get('/api/admin/workflows').set('Authorization', `Bearer ${token}`).expect(200);
    let step = res.body.find((w: any) => w.id === wf.id).steps[0];
    expect(step.roleWarnings.length).toBe(2); // нет прав + нет пользователей
    expect(step.roleWarnings.join(' ')).toMatch(/нет прав/);
    expect(step.roleWarnings.join(' ')).toMatch(/не назначена/);

    // Выдали права и назначили пользователя — предупреждения гаснут.
    await request(app)
      .put(`/api/admin/roles/${rid}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['requests.view', 'approvals.approve', 'approvals.reject'] })
      .expect(200);
    const [u2] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: 'ED', telegramId: 'ed1' }).returning();
    await request(app).post(`/api/admin/users/${u2.id}/roles`).set('Authorization', `Bearer ${token}`).send({ roleId: rid }).expect(201);

    res = await request(app).get('/api/admin/workflows').set('Authorization', `Bearer ${token}`).expect(200);
    step = res.body.find((w: any) => w.id === wf.id).steps[0];
    expect(step.roleWarnings).toEqual([]);
  });
});
