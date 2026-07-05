/**
 * P1-1: a workflow with an amount-gated approval step but no preceding procurement
 * step cannot be ACTIVATED (the threshold would be checked against the requester's
 * self-declared amount, which the create form sends as 0 → high-value approval
 * bypass). With procurement before the threshold, activation is allowed.
 *
 * Also pins the routing invariant: a zero-amount request routed through procurement
 * (which sets the real amount) still hits the threshold approval afterwards.
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
import { firstStep, nextStep } from '../workflow/engine.js';

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
  const app = createApp({ db, botToken: 'test:token', sessionSecret: 'test-secret-long-enough', devAuth: true, rateLimit: false });
  const token = (await request(app).post('/api/auth/dev').send({ telegramId: 'adm' }).expect(200)).body.token as string;
  return { app, db, holding, token };
}

async function newWorkflow(db: any, holdingId: string, name: string) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId, name, isActive: false }).returning();
  return wf.id as string;
}
function activate(app: any, token: string, id: string) {
  return request(app).put(`/api/admin/workflows/${id}`).set('Authorization', `Bearer ${token}`).send({ is_active: true });
}

describe('P1-1: threshold requires procurement (activation guard)', () => {
  it('rejects activating a workflow with a threshold approval but no procurement', async () => {
    const { app, db, holding, token } = await make();
    const id = await newWorkflow(db, holding.id, 'NoProc');
    await db.insert(schema.workflowSteps).values([
      { workflowId: id, stepOrder: 1, stepName: 'Заявка', stepKind: 'approval' },
      { workflowId: id, stepOrder: 2, stepName: 'Директор', stepKind: 'approval', thresholdAmount: 30_000_000 },
    ]);
    const res = await activate(app, token, id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/закупк/i);
    const [wf] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id));
    expect(wf.isActive).toBe(false); // rolled back
  });

  it('allows activating a workflow with procurement before the threshold', async () => {
    const { app, db, holding, token } = await make();
    const id = await newWorkflow(db, holding.id, 'WithProc');
    await db.insert(schema.workflowSteps).values([
      { workflowId: id, stepOrder: 1, stepName: 'Проверка склада', stepKind: 'warehouse_check' },
      { workflowId: id, stepOrder: 2, stepName: 'Снабжение', stepKind: 'procurement' },
      { workflowId: id, stepOrder: 3, stepName: 'Финансы', stepKind: 'approval', thresholdAmount: 5_000_000 },
    ]);
    await activate(app, token, id).expect(200);
  });

  it('routing: a zero-amount request still hits the threshold approval after procurement sets the real amount', () => {
    const steps = [
      { id: 'wh', stepOrder: 1 },
      { id: 'proc', stepOrder: 2 },
      { id: 'fin', stepOrder: 3, thresholdAmount: 5_000_000 },
    ];
    // At creation the amount is self-declared 0: the threshold step is NOT applicable yet,
    // but procurement is, so the request is not auto-finished skipping controls.
    const created = firstStep(steps, { amount: 0 });
    expect(created?.id).toBe('wh');

    // After procurement selects a КП, the amount is real (10M). Routing forward from
    // procurement now reaches the finance threshold approval — it is NOT skipped.
    const afterProc = nextStep(steps, { amount: 10_000_000 }, 2);
    expect(afterProc?.id).toBe('fin');

    // Sanity: with a genuinely tiny verified amount, the threshold correctly does not apply.
    const belowThreshold = nextStep(steps, { amount: 1000 }, 2);
    expect(belowThreshold).toBeNull();
  });
});
