/**
 * NEW-2 regression: once a workflow is ACTIVE, step mutations must not be able to
 * reintroduce the P1-1 bypass (a threshold approval with no procurement before it).
 * The existence invariant is re-checked on add / reorder / delete when the workflow
 * is active. Inactive (under-construction) workflows are still freely editable.
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
  const app = createApp({ db, botToken: 'test:token', sessionSecret: 'test-secret-long-enough', devAuth: true });
  const token = (await request(app).post('/api/auth/dev').send({ telegramId: 'adm' }).expect(200)).body.token as string;
  const post = (wfId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/admin/workflows/${wfId}/steps`).set('Authorization', `Bearer ${token}`).send(body);
  const del = (wfId: string, stepId: string) =>
    request(app).delete(`/api/admin/workflows/${wfId}/steps/${stepId}`).set('Authorization', `Bearer ${token}`);
  return { app, db, holding, token, post, del };
}

/** An ACTIVE workflow with procurement(1) before a finance threshold(2). */
async function activeWithProcurement(db: any, holdingId: string) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId, name: 'Live', isActive: true }).returning();
  const [proc] = await db
    .insert(schema.workflowSteps)
    .values({ workflowId: wf.id, stepOrder: 1, stepName: 'Снабжение', stepKind: 'procurement' })
    .returning();
  await db
    .insert(schema.workflowSteps)
    .values({ workflowId: wf.id, stepOrder: 2, stepName: 'Финансы', stepKind: 'approval', thresholdAmount: 5_000_000 });
  return { wfId: wf.id as string, procId: proc.id as string };
}

describe('NEW-2: active-workflow step mutations keep the procurement invariant', () => {
  it('blocks deleting the procurement step from an active workflow that has a threshold approval', async () => {
    const { db, holding, del } = await make();
    const { wfId, procId } = await activeWithProcurement(db, holding.id);
    const res = await del(wfId, procId);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/закупк/i);
    // Rolled back: procurement step survives.
    const steps = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, wfId));
    expect(steps.some((s: any) => s.id === procId)).toBe(true);
  });

  it('blocks adding a threshold approval with no procurement to an active workflow', async () => {
    const { db, holding, post } = await make();
    // Active workflow with only a warehouse_check step (no procurement).
    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Live2', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Склад', stepKind: 'warehouse_check' });

    const res = await post(wf.id, { name: 'Директор', step_kind: 'approval', order_index: 2, threshold_amount: 30_000_000 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/закупк/i);
    // Rolled back: the threshold step was not persisted.
    const steps = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, wf.id));
    expect(steps).toHaveLength(1);
  });

  it('still allows a valid add on an active workflow (procurement present)', async () => {
    const { db, holding, post } = await make();
    const { wfId } = await activeWithProcurement(db, holding.id);
    // Add a second threshold approval after procurement — valid.
    await post(wfId, { name: 'Директор', step_kind: 'approval', order_index: 3, threshold_amount: 30_000_000 }).expect(201);
  });

  it('does NOT restrict an INACTIVE workflow under construction', async () => {
    const { db, holding, post } = await make();
    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Draft', isActive: false }).returning();
    // A lone threshold approval on an inactive workflow is allowed (built step-by-step).
    await post(wf.id, { name: 'Финансы', step_kind: 'approval', order_index: 1, threshold_amount: 5_000_000 }).expect(201);
  });
});
