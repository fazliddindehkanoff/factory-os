/**
 * P2.2 role matrix — pins "who can do what" for the canonical roles (GPT §9):
 *  - permission capabilities (hasPermission);
 *  - approval is gated by the step's approver role (availableActions);
 *  - request-list visibility (pure requester sees only own).
 *
 * "Archived user cannot login" lives in admin.test.ts; the full pilot golden path
 * lives in services/pilot-golden-path.test.ts — both stay green.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { hasPermission } from './rbac.js';
import { createRequest } from '../services/request.service.js';
import { availableActions } from '../services/lifecycle.service.js';
import { createApp } from '../server/app.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  return { db, h, f };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

async function userWithRole(db: any, h: any, code: string, tg: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId: h.id, fullName: code, telegramId: tg, status: 'active' })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId: h.id });
  return u.id;
}

describe('role matrix — permission capabilities', () => {
  async function can(db: any, h: any, code: string, perm: string, tg: string) {
    const uid = await userWithRole(db, h, code, tg);
    return hasPermission(db, uid, perm, { holdingId: h.id });
  }

  it('requester: creates, but cannot approve / issue / mark-paid / view audit', async () => {
    const { db, h } = await setup();
    expect(await can(db, h, 'requester', 'requests.create', 'a1')).toBe(true);
    expect(await can(db, h, 'requester', 'approvals.approve', 'a2')).toBe(false);
    expect(await can(db, h, 'requester', 'warehouse.issue', 'a3')).toBe(false);
    expect(await can(db, h, 'requester', 'finance.mark_paid', 'a4')).toBe(false);
    expect(await can(db, h, 'requester', 'audit.view', 'a5')).toBe(false);
  });

  it('warehouse: checks/issues, but cannot mark-paid / manage users', async () => {
    const { db, h } = await setup();
    expect(await can(db, h, 'warehouse', 'warehouse.check_stock', 'b1')).toBe(true);
    expect(await can(db, h, 'warehouse', 'warehouse.issue', 'b2')).toBe(true);
    expect(await can(db, h, 'warehouse', 'finance.mark_paid', 'b3')).toBe(false);
    expect(await can(db, h, 'warehouse', 'users.manage', 'b4')).toBe(false);
  });

  it('finance cannot mutate the warehouse; procurement cannot mark-paid', async () => {
    const { db, h } = await setup();
    expect(await can(db, h, 'finance_head', 'finance.mark_paid', 'c1')).toBe(true);
    expect(await can(db, h, 'finance_head', 'warehouse.issue', 'c2')).toBe(false);
    expect(await can(db, h, 'procurement_head', 'procurement.select_supplier', 'c3')).toBe(true);
    expect(await can(db, h, 'procurement_head', 'finance.mark_paid', 'c4')).toBe(false);
  });

  it('admin manages users/roles but is NOT an automatic business approver', async () => {
    const { db, h } = await setup();
    expect(await can(db, h, 'admin', 'users.manage', 'd1')).toBe(true);
    expect(await can(db, h, 'admin', 'roles.manage', 'd2')).toBe(true);
    expect(await can(db, h, 'admin', 'approvals.approve', 'd3')).toBe(false);
    expect(await can(db, h, 'admin', 'warehouse.issue', 'd4')).toBe(false);
    expect(await can(db, h, 'admin', 'finance.mark_paid', 'd5')).toBe(false);
  });

  it('auditor views audit but mutates nothing; observer is read-only', async () => {
    const { db, h } = await setup();
    expect(await can(db, h, 'auditor', 'audit.view', 'e1')).toBe(true);
    expect(await can(db, h, 'auditor', 'requests.create', 'e2')).toBe(false);
    expect(await can(db, h, 'auditor', 'approvals.approve', 'e3')).toBe(false);
    expect(await can(db, h, 'auditor', 'warehouse.issue', 'e4')).toBe(false);
    expect(await can(db, h, 'observer', 'requests.view', 'e5')).toBe(true);
    expect(await can(db, h, 'observer', 'requests.create', 'e6')).toBe(false);
    expect(await can(db, h, 'observer', 'approvals.approve', 'e7')).toBe(false);
    expect(await can(db, h, 'observer', 'users.manage', 'e8')).toBe(false);
  });
});

describe('role matrix — approval is gated by the step approver role', () => {
  async function approvalReq(db: any, h: any, f: any, approverRoleCode: string, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id,
      stepOrder: 1,
      stepName: 'Согласование',
      stepKind: 'approval',
      approverRoleId: await roleId(db, approverRoleCode),
    });
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }
  const acts = (l: { action: string }[]) => l.map((a) => a.action);

  it('director (the step approver) gets approve; warehouse and the author do not', async () => {
    const { db, h, f } = await setup();
    const requester = await userWithRole(db, h, 'requester', 'r1');
    const director = await userWithRole(db, h, 'director', 'dir1');
    const wh = await userWithRole(db, h, 'warehouse', 'wh1');
    const req = await approvalReq(db, h, f, 'director', requester);

    expect(acts(await availableActions(db, req, director))).toContain('approve');
    // warehouse HOLDS approvals.approve but is not the director on this step → no approve
    expect(acts(await availableActions(db, req, wh))).not.toContain('approve');
    // the author cannot approve their own request (separation of duties)
    expect(acts(await availableActions(db, req, requester))).not.toContain('approve');
  });

  it('a director cannot approve a step assigned to a different approver role', async () => {
    const { db, h, f } = await setup();
    const requester = await userWithRole(db, h, 'requester', 'r2');
    const director = await userWithRole(db, h, 'director', 'dir2');
    const req = await approvalReq(db, h, f, 'finance_head', requester);
    expect(acts(await availableActions(db, req, director))).not.toContain('approve');
  });
});

describe('role matrix — request list visibility', () => {
  function app(db: any) {
    return createApp({ db, botToken: 'test:token', sessionSecret: 'test-secret-long-enough', devAuth: true, rateLimit: false });
  }
  async function token(a: any, tg: string) {
    return (await request(a).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
  }

  it('a pure requester sees only their own requests; an oversight role sees all', async () => {
    const { db, h, f } = await setup();
    const r1 = await userWithRole(db, h, 'requester', 'q1');
    const r2 = await userWithRole(db, h, 'requester', 'q2');
    await userWithRole(db, h, 'director', 'qd');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({
      workflowId: wf.id,
      stepOrder: 1,
      stepName: 'A',
      stepKind: 'approval',
      approverRoleId: await roleId(db, 'director'),
    });
    await createRequest(db, { holdingId: h.id, requesterId: r1, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 1 }] });
    await createRequest(db, { holdingId: h.id, requesterId: r2, factoryId: f.id, items: [{ name: 'Y', quantity: 1, unitPrice: 1 }] });

    const a = app(db);
    const t1 = await token(a, 'q1');
    const list1 = await request(a).get('/api/requests').set('Authorization', `Bearer ${t1}`).expect(200);
    expect(list1.body.items.length).toBe(1); // only their own

    const td = await token(a, 'qd');
    const listD = await request(a).get('/api/requests').set('Authorization', `Bearer ${td}`).expect(200);
    expect(listD.body.items.length).toBe(2); // oversight sees all
  });
});
