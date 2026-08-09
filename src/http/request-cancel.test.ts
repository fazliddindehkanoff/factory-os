/**
 * Bug #5: the author may cancel their own request while no one has approved it.
 * Soft cancel keeps the row + full history; only the author, only pre-approval.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';
import { createRequest } from '../services/request.service.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const roleId = async (c: string) => (await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, c))))[0].id as string;
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Рук', stepKind: 'approval', approverRoleId: await roleId('dept_head') });
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  const user = async (tg: string, code: string) => {
    const login = await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200);
    const uid = login.body.user.id as string;
    await db.update(schema.users).set({ holdingId: holding.id, status: 'active' }).where(eq(schema.users.id, uid));
    await db.insert(schema.userRoles).values({ userId: uid, roleId: await roleId(code), holdingId: holding.id });
    return { uid, token: login.body.token as string };
  };
  // a dept_head must exist so the step isn't auto-skipped for the author
  await user('dh', 'dept_head');
  return { app, db, holding, factory, user };
}

describe('bug #5: cancel own request', () => {
  it('author cancels a pending request → cancelled, with history + audit', async () => {
    const { app, db, holding, factory, user } = await make();
    const author = await user('author', 'requester');
    const req = await createRequest(db, { holdingId: holding.id, requesterId: author.uid, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    await request(app).post(`/api/requests/${req.id}/cancel`).set('Authorization', `Bearer ${author.token}`).send({ reason: 'передумал' }).expect(200);

    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(row.status).toBe('cancelled');
    expect(row.currentStepId).toBeNull();
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, req.id));
    expect(audit.some((a: any) => a.action === 'request.cancelled')).toBe(true);
    const hist = await db.select().from(schema.requestStatusHistory).where(eq(schema.requestStatusHistory.requestId, req.id));
    expect(hist.some((h: any) => h.newStatus === 'cancelled' && h.changedBy === author.uid)).toBe(true);
  });

  it('a non-author cannot cancel someone else request → 403', async () => {
    const { app, db, holding, factory, user } = await make();
    const author = await user('author', 'requester');
    const other = await user('other', 'requester');
    const req = await createRequest(db, { holdingId: holding.id, requesterId: author.uid, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    await request(app).post(`/api/requests/${req.id}/cancel`).set('Authorization', `Bearer ${other.token}`).send({}).expect(403);
  });

  it('cannot cancel after an approval exists → 409', async () => {
    const { app, db, holding, factory, user } = await make();
    const author = await user('author', 'requester');
    const req = await createRequest(db, { holdingId: holding.id, requesterId: author.uid, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    // simulate the first approver having approved
    await db.update(schema.approvals).set({ status: 'approved' }).where(eq(schema.approvals.requestId, req.id));
    await request(app).post(`/api/requests/${req.id}/cancel`).set('Authorization', `Bearer ${author.token}`).send({}).expect(409);
  });
});
