/**
 * H3 — GET /requests/:id and the dashboard must respect the same own-or-oversight
 * visibility as the list (no intra-tenant IDOR; foreign id → 404).
 * H4 — attachment upload/list/download require request visibility, and upload
 * requires requests.upload_attachment (or ownership).
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
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';
const B64 = Buffer.from('hello-file').toString('base64');

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  const roleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  // Workflow has a director approval step AND a warehouse check step, so both
  // director and warehouse are legitimate "role-in-workflow" viewers (bug #2).
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'A', stepKind: 'approval', approverRoleId: await roleId('director') });
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 2, stepName: 'WH', stepKind: 'warehouse_check', approverRoleId: await roleId('warehouse') });
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false });
  const user = async (codes: string[], tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    for (const c of codes) await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(c), holdingId: holding.id });
    return u.id;
  };
  const mkReq = (requesterId: string) =>
    createRequest(db, { holdingId: holding.id, requesterId, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  const login = async (tg: string): Promise<string> => (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
  return { app, db, holding, factory, user, mkReq, login };
}

describe('H3 — request detail visibility', () => {
  it('a requester cannot read another user\'s request (404, not 403/200)', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['requester'], 'bob');
    const reqA = await mkReq(alice);
    const bobTk = await login('bob');
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${bobTk}`).expect(404);
  });

  it('a requester can read their own request', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    const reqA = await mkReq(alice);
    const tk = await login('alice');
    const res = await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
    expect(res.body.id).toBe(reqA.id);
  });

  it('an observer cannot read another user\'s request (no oversight perm)', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['observer'], 'obs');
    const reqA = await mkReq(alice);
    const tk = await login('obs');
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(404);
  });

  it('a top role (director, audit.view) can read any request in the holding', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['director'], 'dir');
    const reqA = await mkReq(alice);
    const tk = await login('dir');
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
  });

  // bug #2: a former "oversight" permission alone no longer grants visibility —
  // finance.view without a finance step in the workflow → cannot see the request.
  it('a role with finance.view but NO step in the workflow cannot see the request (404)', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['finance'], 'fin'); // finance.view, but workflow has only director + warehouse steps
    const reqA = await mkReq(alice);
    const tk = await login('fin');
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(404);
  });

  // bug #2: warehouse is an approver step in this workflow → it sees the request
  // even though it did not create it (role-in-workflow).
  it('warehouse (a step in the workflow) can see a request it did not create (200)', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['warehouse'], 'wh2');
    const reqA = await mkReq(alice);
    const tk = await login('wh2');
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
  });

  // Regression: a procurement user participates in the procurement step BY PERMISSION
  // even if their role isn't literally the step's approver role — so tapping the
  // request from their inbox must open it (was 404).
  it('a procurement user can open a request whose workflow has a procurement step (200)', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    await seedSystemRolesAndPermissions(db);
    const [holding] = await db.insert(schema.holdings).values({ name: 'H2' }).returning();
    const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
    const rid = async (c: string) => (await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, c))))[0].id as string;
    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'WP', isActive: true }).returning();
    // procurement step's approver is procurement_manager (a DIFFERENT role than 'procurement')
    await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await rid('procurement_manager') });
    const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false });
    const mk = async (codes: string[], tg: string) => {
      const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
      for (const c of codes) await db.insert(schema.userRoles).values({ userId: u.id, roleId: await rid(c), holdingId: holding.id });
      return u.id;
    };
    const alice = await mk(['requester'], 'a2');
    await mk(['procurement'], 'proc'); // Снабжение: has procurement perms, role != procurement_manager
    const reqA = await createRequest(db, { holdingId: holding.id, requesterId: alice, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    const tk = (await request(app).post('/api/auth/dev').send({ telegramId: 'proc' }).expect(200)).body.token as string;
    await request(app).get(`/api/requests/${reqA.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
  });

  it('dashboard activity shows only the user\'s own requests for a pure requester', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    const bob = await user(['requester'], 'bob');
    const reqA = await mkReq(alice);
    await mkReq(bob);
    const tk = await login('bob');
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${tk}`).expect(200);
    expect(res.body.activity.some((a: { id: string }) => a.id === reqA.id)).toBe(false);
  });
});

describe('H4 — attachment access', () => {
  it('owner can upload to their own request', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    const reqA = await mkReq(alice);
    const tk = await login('alice');
    await request(app).post(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${tk}`).send({ filename: 'f.txt', dataBase64: B64 }).expect(201);
  });

  it('a requester cannot upload to another user\'s request (404 — cannot see it)', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['requester'], 'bob');
    const reqA = await mkReq(alice);
    const tk = await login('bob');
    await request(app).post(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${tk}`).send({ filename: 'f.txt', dataBase64: B64 }).expect(404);
  });

  it('an oversight user who can SEE but lacks upload permission → 403 on upload', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['warehouse'], 'wh'); // warehouse.view = oversight, but no requests.upload_attachment
    const reqA = await mkReq(alice);
    const tk = await login('wh');
    await request(app).post(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${tk}`).send({ filename: 'f.txt', dataBase64: B64 }).expect(403);
  });

  it('a user who cannot see the request cannot list or download its attachments (404)', async () => {
    const { app, db, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['requester'], 'bob');
    const reqA = await mkReq(alice);
    const aliceTk = await login('alice');
    const up = await request(app).post(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${aliceTk}`).send({ filename: 'f.txt', dataBase64: B64 }).expect(201);
    const bobTk = await login('bob');
    await request(app).get(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${bobTk}`).expect(404);
    await request(app).get(`/api/attachments/${up.body.id}`).set('Authorization', `Bearer ${bobTk}`).expect(404);
    // upload was audited
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'attachment.uploaded'));
    expect(audit.length).toBe(1);
  });

  it('delete stays protected: a non-uploader without requests.edit cannot delete', async () => {
    const { app, user, mkReq, login } = await make();
    const alice = await user(['requester'], 'alice');
    await user(['director'], 'dir'); // oversight (can see) but not uploader, no requests.edit
    const reqA = await mkReq(alice);
    const aliceTk = await login('alice');
    const up = await request(app).post(`/api/requests/${reqA.id}/attachments`).set('Authorization', `Bearer ${aliceTk}`).send({ filename: 'f.txt', dataBase64: B64 }).expect(201);
    const dirTk = await login('dir');
    await request(app).delete(`/api/attachments/${up.body.id}`).set('Authorization', `Bearer ${dirTk}`).expect(403);
    // uploader can delete
    await request(app).delete(`/api/attachments/${up.body.id}`).set('Authorization', `Bearer ${aliceTk}`).expect(200);
  });
});
