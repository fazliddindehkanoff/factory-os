/**
 * H1 regression — the workflow constructor must refuse a layout where an
 * amount-gated approval step sits BEFORE a procurement step: routing only moves
 * forward, so once the КП raises the amount the threshold approval behind the
 * cursor never re-fires (financial-control bypass).
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

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [admin] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'adm', telegramId: 'adm', status: 'active' })
    .returning();
  const [role] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, 'admin')));
  await db.insert(schema.userRoles).values({ userId: admin.id, roleId: role.id, holdingId: holding.id });
  // Build steps on an INACTIVE workflow (the realistic constructor flow: build,
  // then activate). This test pins the H1 *ordering* rule, which is independent of
  // active state. The stronger existence rule for ACTIVE workflows is covered by
  // workflow-active-step-invariant.test.ts (NEW-2).
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: false }).returning();
  const app = createApp({ db, botToken: 'test:token', sessionSecret: 'test-secret-long-enough', devAuth: true });
  const token = (await request(app).post('/api/auth/dev').send({ telegramId: 'adm' }).expect(200)).body.token as string;
  const post = (body: Record<string, unknown>) =>
    request(app).post(`/api/admin/workflows/${wf.id}/steps`).set('Authorization', `Bearer ${token}`).send(body);
  return { app, db, wf, token, post };
}

describe('H1 — constructor rejects thresholds placed before procurement', () => {
  it('threshold approval BEFORE procurement → 400; AFTER → 201', async () => {
    const { post } = await make();
    await post({ name: 'Финансы', step_kind: 'approval', order_index: 1, threshold_amount: 5_000_000 }).expect(201);
    // Adding procurement AFTER the threshold approval creates the bypass layout.
    const bad = await post({ name: 'Закупка', step_kind: 'procurement', order_index: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/финконтроль/);
  });

  it('procurement first, thresholds after → allowed', async () => {
    const { post } = await make();
    await post({ name: 'Закупка', step_kind: 'procurement', order_index: 1 }).expect(201);
    await post({ name: 'Финансы', step_kind: 'approval', order_index: 2, threshold_amount: 5_000_000 }).expect(201);
    await post({ name: 'Директор', step_kind: 'approval', order_index: 3, condition_rule: { amountGte: 30_000_000 } }).expect(201);
  });

  it('reorder that moves a threshold approval before procurement → 409/400 and rolls back', async () => {
    const { post, app, token, wf, db } = await make();
    const proc = (await post({ name: 'Закупка', step_kind: 'procurement', order_index: 1 }).expect(201)).body;
    const fin = (await post({ name: 'Финансы', step_kind: 'approval', order_index: 2, threshold_amount: 5_000_000 }).expect(201)).body;

    const res = await request(app)
      .put(`/api/admin/workflows/${wf.id}/steps/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send([
        { id: fin.id, order_index: 1 },
        { id: proc.id, order_index: 2 },
      ]);
    expect(res.status).toBe(400);

    // Rolled back: the original order survives.
    const steps = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, wf.id));
    const byId = new Map(steps.map((s: { id: string; stepOrder: number }) => [s.id, s.stepOrder]));
    expect(byId.get(proc.id)).toBe(1);
    expect(byId.get(fin.id)).toBe(2);
  });
});
