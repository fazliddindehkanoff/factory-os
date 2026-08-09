/**
 * Compat layer hardening (SERVE_DESIGN=1):
 *  P1-2: approve requires a valid PIN for EVERY role, not just money stages.
 *  P1-3: role assignment cannot escalate beyond the actor's own permissions,
 *        and does not hard-delete assignment history.
 *  P1-4: a quotation can only be selected while the request is on a procurement step.
 *  Strategy: in production, all compat mutations are disabled (410).
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';
import { hashPin } from '../auth/pin.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function makeCompatApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, serveDesign: true });
  return { app, db };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

async function mkUser(db: any, holdingId: string, tg: string, roleCode: string, pin?: string) {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, telegramId: tg, fullName: tg, status: 'active', pinHash: pin ? hashPin(pin) : null })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, roleCode), holdingId });
  return u;
}

const ORIG_ENV = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = ORIG_ENV; });

describe('compat P1-2: approve always needs a PIN', () => {
  it('custom-role approver cannot approve through compat without a PIN', async () => {
    const { app, db } = await makeCompatApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    // A custom role that can approve but is NOT finance/director/owner.
    const [role] = await db.insert(schema.roles).values({ holdingId: h.id, code: 'inspector', name: 'Inspector' }).returning();
    const [perm] = await db.select().from(schema.permissions).where(eq(schema.permissions.code, 'approvals.approve'));
    await db.insert(schema.rolePermissions).values({ roleId: role.id, permissionId: perm.id });
    const [approver] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, telegramId: 'insp', fullName: 'Insp', status: 'active' }) // no PIN
      .returning();
    await db.insert(schema.userRoles).values({ userId: approver.id, roleId: role.id, holdingId: h.id });

    const requester = await mkUser(db, h.id, 'req', 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    const [step] = await db
      .insert(schema.workflowSteps)
      .values({ workflowId: wf.id, stepOrder: 1, stepName: 'Проверка', stepKind: 'approval', approverRoleId: role.id })
      .returning();
    const [req] = await db
      .insert(schema.requests)
      .values({ requestNumber: 'R-1', holdingId: h.id, requesterId: requester.id, workflowId: wf.id, currentStepId: step.id, status: 'pending_approval' })
      .returning();
    const [ap] = await db.insert(schema.approvals).values({ requestId: req.id, workflowStepId: step.id, status: 'pending' }).returning();

    const res = await request(app)
      .post(`/api/approvals/${ap.id}/approve`)
      .set('X-Dev-User-Id', 'insp')
      .send({});
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/PIN/i);
  });
});

describe('compat R2: approve is gated by the approvals.approve permission', () => {
  it('a user without approvals.approve gets 403 before anything is written', async () => {
    const { app, db } = await makeCompatApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    // Custom role WITHOUT approvals.approve, but named as the step's approver —
    // the step-role match alone must not authorize the action.
    const [role] = await db.insert(schema.roles).values({ holdingId: h.id, code: 'watcher', name: 'Watcher' }).returning();
    const [watcher] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, telegramId: 'wtch', fullName: 'W', status: 'active', pinHash: hashPin('123456') })
      .returning();
    await db.insert(schema.userRoles).values({ userId: watcher.id, roleId: role.id, holdingId: h.id });

    const requester = await mkUser(db, h.id, 'req2', 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W2', isActive: true }).returning();
    const [step] = await db
      .insert(schema.workflowSteps)
      .values({ workflowId: wf.id, stepOrder: 1, stepName: 'Проверка', stepKind: 'approval', approverRoleId: role.id })
      .returning();
    const [req] = await db
      .insert(schema.requests)
      .values({ requestNumber: 'R-2', holdingId: h.id, requesterId: requester.id, workflowId: wf.id, currentStepId: step.id, status: 'pending_approval' })
      .returning();
    const [ap] = await db.insert(schema.approvals).values({ requestId: req.id, workflowStepId: step.id, status: 'pending' }).returning();

    const res = await request(app)
      .post(`/api/approvals/${ap.id}/approve`)
      .set('X-Dev-User-Id', 'wtch')
      .send({ pin: '123456' });
    expect(res.status).toBe(403);
    const sigRows = await db.select().from(schema.signatures).where(eq(schema.signatures.approvalId, ap.id));
    expect(sigRows.length).toBe(0);
  });
});

describe('compat P1-3: no privilege escalation via /admin/users', () => {
  it('a users.manage holder without high perms cannot grant the finance role', async () => {
    const { app, db } = await makeCompatApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    // Custom role: ONLY users.manage.
    const [role] = await db.insert(schema.roles).values({ holdingId: h.id, code: 'hr', name: 'HR' }).returning();
    const [perm] = await db.select().from(schema.permissions).where(eq(schema.permissions.code, 'users.manage'));
    await db.insert(schema.rolePermissions).values({ roleId: role.id, permissionId: perm.id });
    const [hr] = await db.insert(schema.users).values({ holdingId: h.id, telegramId: 'hr', fullName: 'HR', status: 'active' }).returning();
    await db.insert(schema.userRoles).values({ userId: hr.id, roleId: role.id, holdingId: h.id });

    // finance role has finance.mark_paid etc. — beyond HR's own perms.
    const res = await request(app)
      .post('/api/admin/users')
      .set('X-Dev-User-Id', 'hr')
      .send({ telegram_id: 'newbie', first_name: 'New', role: 'finance' });
    expect(res.status).toBe(403);
  });

  it('reassigning a role revokes the old assignment instead of deleting it', async () => {
    const { app, db } = await makeCompatApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    await mkUser(db, h.id, 'owner', 'owner'); // owner can grant anything
    const target = await mkUser(db, h.id, 'tgt', 'requester');

    await request(app)
      .patch(`/api/admin/users/${target.id}`)
      .set('X-Dev-User-Id', 'owner')
      .send({ role: 'warehouse' })
      .expect(200);

    const roles = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, target.id));
    // History preserved: the old requester assignment is revoked, not gone.
    expect(roles.length).toBe(2);
    expect(roles.filter((r: any) => r.status === 'active')).toHaveLength(1);
    expect(roles.some((r: any) => r.status === 'revoked')).toBe(true);
  });
});

describe('compat P1-4: quotation select only on a procurement step', () => {
  async function seedReqOnStep(db: any, stepKind: string) {
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const buyer = await mkUser(db, h.id, 'proc', 'procurement', '1234');
    const requester = await mkUser(db, h.id, 'req', 'requester');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    const [step] = await db
      .insert(schema.workflowSteps)
      .values({ workflowId: wf.id, stepOrder: 1, stepName: 'S', stepKind })
      .returning();
    const [req] = await db
      .insert(schema.requests)
      .values({ requestNumber: 'R-1', holdingId: h.id, requesterId: requester.id, workflowId: wf.id, currentStepId: step.id, status: stepKind })
      .returning();
    const [q] = await db
      .insert(schema.quotations)
      .values({ holdingId: h.id, requestId: req.id, supplierName: 'S', amount: 9_000_000, createdBy: buyer.id })
      .returning();
    return { q };
  }

  it('rejects selecting a quotation when the request is past procurement', async () => {
    const { app, db } = await makeCompatApp();
    const { q } = await seedReqOnStep(db, 'approval'); // not procurement
    const res = await request(app).patch(`/api/quotations/${q.id}/select`).set('X-Dev-User-Id', 'proc').send({});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/REAPPROVAL_REQUIRED/);
  });

  it('allows selecting a quotation while on the procurement step', async () => {
    const { app, db } = await makeCompatApp();
    const { q } = await seedReqOnStep(db, 'procurement');
    await request(app).patch(`/api/quotations/${q.id}/select`).set('X-Dev-User-Id', 'proc').send({}).expect(200);
  });
});

describe('compat strategy: production disables mutations', () => {
  it('returns 410 for compat mutations when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const { app, db } = await makeCompatApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    await mkUser(db, h.id, 'owner', 'owner');
    const res = await request(app).post('/api/admin/users').set('X-Dev-User-Id', 'owner').send({ telegram_id: 'x', first_name: 'X', role: 'requester' });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('COMPAT_READONLY');
  });
});
