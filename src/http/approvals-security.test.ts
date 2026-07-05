/**
 * C1 regression — /api/approvals/:id/approve must be fail-closed:
 * permission (approvals.approve) + assigned approver role + valid PIN + no
 * self-approval; a step with no approver role is 409 (misconfigured), not an
 * open door; the telegram_pin signature/audit is written ONLY after a valid PIN.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from '../services/request.service.js';
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

async function approvalFlow(db: any, holding: any, factory: any, requesterId: string, approverRoleId: string | null) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Appr', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
  ]);
  const req = await createRequest(db, { holdingId: holding.id, requesterId, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  const [appr] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
  return { req, approvalId: appr.id };
}
const sigs = (db: any, approvalId: string) => db.select().from(schema.signatures).where(eq(schema.signatures.approvalId, approvalId));
const approvedAudit = (db: any, approvalId: string) =>
  db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, approvalId), eq(schema.auditLogs.action, 'approval.approved')));

describe('C1 — approve endpoint is fail-closed', () => {
  it('without PIN → 403, and no signature/audit written', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));
    const dir = await login(app, 'dir');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({}).expect(403);
    expect((await sigs(db, approvalId)).length).toBe(0);
    expect((await approvedAudit(db, approvalId)).length).toBe(0);
  });

  it('with wrong PIN → 403, and no signature/audit written', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));
    const dir = await login(app, 'dir');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: '0000' }).expect(403);
    expect((await sigs(db, approvalId)).length).toBe(0);
    expect((await approvedAudit(db, approvalId)).length).toBe(0);
  });

  it('without approvals.approve permission → 403', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    // A plain requester (no approvals.approve) is also the actor here.
    const other = await userWithRoles(db, holding, ['requester'], 'req2', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));
    const tk = await login(app, 'req2');
    void other;

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${tk}`).send({ pin: PIN }).expect(403);
  });

  it('has approvals.approve but wrong role for the step → 403', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    // dept_head holds approvals.approve but is NOT the step's approver role (director).
    await userWithRoles(db, holding, ['dept_head'], 'dh', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));
    const dh = await login(app, 'dh');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dh}`).send({ pin: PIN }).expect(403);
  });

  it('approval step with NO approver role → 409 (fail-closed), not approvable by anyone', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, requester, null); // step has no approver role
    const dir = await login(app, 'dir');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: PIN }).expect(409);
    expect((await sigs(db, approvalId)).length).toBe(0);
  });

  it('self-approval forbidden even with permission + role + PIN → 403', async () => {
    const { app, db, holding, factory } = await make();
    // Same person creates AND would approve (has both requester + director).
    const self = await userWithRoles(db, holding, ['requester', 'director'], 'self', PIN);
    // A SECOND director must exist, else the director step is auto-skipped (bug #1);
    // here we test that self-approval stays blocked while the step is live.
    await userWithRoles(db, holding, ['director'], 'dir2', PIN);
    const { approvalId } = await approvalFlow(db, holding, factory, self, await roleId(db, 'director'));
    const tk = await login(app, 'self');

    await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${tk}`).send({ pin: PIN }).expect(403);
  });

  it('valid approver + valid PIN → success, with signature + audit written only then', async () => {
    const { app, db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    await userWithRoles(db, holding, ['director'], 'dir', PIN);
    const { req, approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));
    const dir = await login(app, 'dir');

    const res = await request(app).post(`/api/approvals/${approvalId}/approve`).set('Authorization', `Bearer ${dir}`).send({ pin: PIN }).expect(200);
    expect(res.body.requestId).toBe(req.id);
    const s = await sigs(db, approvalId);
    expect(s.length).toBe(1);
    expect(s[0].signatureType).toBe('telegram_pin');
    expect((await approvedAudit(db, approvalId)).length).toBe(1);
    // E12: the next step is kind 'close' (non-approval) — the request state must
    // reflect that step's kind and carry NO pending approval row (C1 guard).
    const [after] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(after.status).toBe('close');
    expect(after.currentStepId).not.toBeNull();
    const pend = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
    expect(pend.length).toBe(0);
  });
});
