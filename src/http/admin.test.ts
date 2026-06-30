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
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false });
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
    expect(perms.body.length).toBe(33);

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
  });

  it('blocks privilege escalation: cannot grant a permission you do not hold', async () => {
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
    // Make a target role and try to grant finance.mark_paid (which the actor lacks).
    const created = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'x', name: 'X' })
      .expect(201);
    await request(app)
      .put(`/api/admin/roles/${created.body.id}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['finance.mark_paid'] })
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
    const { app } = await make(); // setupTenant sets factory_name='Zelal' and an 11-step workflow
    const token = await login(app, '999');

    const cfg = await request(app).get('/api/config').set('Authorization', `Bearer ${token}`).expect(200);
    expect(cfg.body.factoryName).toBe('Zelal');
    expect(cfg.body.stages.length).toBe(11);

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
    // existing demo user already in this holding → 200
    await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ telegram_id: 'demo_requester', name: 'X' })
      .expect(200);
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
    await request(app)
      .delete(`/api/admin/users/${target.id}/roles/${rid}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after = await request(app)
      .get(`/api/admin/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.length).toBe(0);
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

  it('refuses to edit permissions of a system role', async () => {
    const { app, db } = await make();
    const token = await login(app, '999');
    await request(app)
      .put(`/api/admin/roles/${await roleId(db, 'owner')}/permissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: ['requests.view'] })
      .expect(403);
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
    const steps = await request(app)
      .get(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(steps.body[0].id).toBe(s2.body.id);
    await request(app)
      .delete(`/api/admin/workflows/${wf.body.id}/steps/${s1.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const steps2 = await request(app)
      .get(`/api/admin/workflows/${wf.body.id}/steps`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(steps2.body.length).toBe(1);
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
