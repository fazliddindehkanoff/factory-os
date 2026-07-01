/**
 * C1 regression — the /api/approvals/:id/approve branch must advance a request
 * EXACTLY like performAction does: the new status comes from statusForStep(next)
 * and a pending approval row is created ONLY when the next step is an approval
 * step. Before the fix, approveApproval unconditionally wrote 'pending_approval'
 * and inserted a pending approval on ANY next step kind, leaving an orphan
 * pending row that later violates approvals_one_pending_idx (23505 → HTTP 500)
 * and bricks the request forever.
 *
 * Also covers B2: an approval whose request already reached a terminal state
 * (currentStepId = null) must be rejected with 409, not reopen the request.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { hashPin } from '../auth/pin.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';
const PIN = '1234';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false });
  return { app, db, holding, factory };
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function userWithRoles(db: any, holding: any, codes: string[], tg: string, pin?: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active', ...(pin ? { pinHash: hashPin(pin) } : {}) })
    .returning();
  for (const c of codes) await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, c), holdingId: holding.id });
  return u.id;
}
const login = async (app: any, tg: string): Promise<string> =>
  (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;

/** approval(director) → warehouse_check(warehouse) → approval(finance) → close(requester) */
async function branchedFlow(db: any, holding: any, factory: any, requesterId: string) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Branch', isActive: true }).returning();
  const steps = await db
    .insert(schema.workflowSteps)
    .values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'director') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Проверка склада', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Финансы', stepKind: 'approval', approverRoleId: await roleId(db, 'finance') },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ])
    .returning();
  const req = await createRequest(db, {
    holdingId: holding.id,
    requesterId,
    factoryId: factory.id,
    items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
  });
  const [appr] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
  return { req, steps, approvalId: appr.id };
}

const pendings = (db: any, requestId: string) =>
  db.select().from(schema.approvals).where(and(eq(schema.approvals.requestId, requestId), eq(schema.approvals.status, 'pending')));
const reload = async (db: any, requestId: string) => {
  const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, requestId));
  return r;
};

describe('C1 — approveApproval must advance like performAction (statusForStep + approval only for approval steps)', () => {
  it('next step is warehouse_check → status is warehouse_check and NO orphan pending approval', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { req, steps, approvalId } = await branchedFlow(db, holding, factory, requester);
    const dir = await login(app, 'dir');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: PIN }).expect(200);

    const r = await reload(db, req.id);
    // The next step is warehouse_check — the status must be the step kind, not 'pending_approval'.
    expect(r.currentStepId).toBe(steps[1].id);
    expect(r.status).toBe('warehouse_check');
    // No approval row may exist for a non-approval step (orphan pending).
    expect((await pendings(db, req.id)).length).toBe(0);
  });

  it('full chain via approveApproval then lifecycle does not violate approvals_one_pending_idx', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    await userWithRoles(db, holding, ['warehouse'], 'wh', PIN);
    await userWithRoles(db, holding, ['finance'], 'fin', PIN);
    const { req, steps, approvalId } = await branchedFlow(db, holding, factory, requester);
    const dir = await login(app, 'dir');
    const wh = await login(app, 'wh');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: PIN }).expect(200);

    // Advancing off the warehouse_check step lands on the finance approval step:
    // enterApprovalIfNeeded inserts its pending row — the partial unique index
    // approvals_one_pending_idx must NOT be violated (no orphan may be left behind).
    const res = await request(app)
      .post(`/api/requests/${req.id}/action`)
      .set('Authorization', `Bearer ${wh}`)
      .send({ action: 'wh_in_stock' });
    expect(res.status).toBe(200);

    const r = await reload(db, req.id);
    expect(r.currentStepId).toBe(steps[2].id);
    expect(r.status).toBe('pending_approval');
    expect((await pendings(db, req.id)).length).toBe(1);
  });
});

describe('B2 — approval on a terminal request is 409, never a reopen', () => {
  it('pending approval left on a closed request cannot flip it back', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { req, steps, approvalId } = await branchedFlow(db, holding, factory, requester);
    const dir = await login(app, 'dir');

    // Force the request into a terminal state while its approval is still pending
    // (models the orphan-pending corruption C1 used to create).
    await db
      .update(schema.requests)
      .set({ status: 'approved', currentStepId: null, closedAt: new Date() })
      .where(eq(schema.requests.id, req.id));
    void steps;

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: PIN }).expect(409);

    const r = await reload(db, req.id);
    expect(r.status).toBe('approved');
    expect(r.currentStepId).toBeNull();
  });
});
