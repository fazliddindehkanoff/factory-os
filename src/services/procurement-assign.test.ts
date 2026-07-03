/**
 * Bug #8: the procurement head assigns a request to a specific снабженец. Only that
 * person then works the procurement step; the request returns to the head afterwards.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction, availableActions } from './lifecycle.service.js';
import { hashPin } from '../auth/pin.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const rid = async (c: string) => (await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, c))))[0].id as string;
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'WF', isActive: true }).returning();
  // step1: procurement head approval → step2: procurement (manager) → step3: head approval
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Нач. снабжения', stepKind: 'approval', approverRoleId: await rid('procurement_head') });
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 2, stepName: 'Снабжение', stepKind: 'procurement', approverRoleId: await rid('procurement_manager') });
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 3, stepName: 'Нач. снабжения', stepKind: 'approval', approverRoleId: await rid('procurement_head') });
  const mk = async (tg: string, code: string, pin = true) => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active', pinHash: pin ? hashPin('1234') : null }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await rid(code), holdingId: holding.id });
    return u.id as string;
  };
  return { db, holding, factory, mk };
}

describe('bug #8: assign to a specific procurement person', () => {
  it('head assigns → responsibleUserId set, advances to procurement, only assignee works it', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head', 'procurement_head');
    const proc1 = await mk('proc1', 'procurement_manager');
    const proc2 = await mk('proc2', 'procurement_manager');
    const requester = await mk('req', 'requester', false);
    const created = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    // At step1 the head should see the "assign" action (next step is procurement).
    let [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    const headActions = await availableActions(db, req, head);
    expect(headActions.some((a) => a.action === 'assign_procurement')).toBe(true);

    // Head assigns proc1.
    await performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: proc1 });

    [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(req.responsibleUserId).toBe(proc1);
    expect(req.status).toBe('procurement');

    // Only proc1 can work the procurement step; proc2 is locked out.
    expect((await availableActions(db, req, proc1)).some((a) => a.action === 'add_quotation')).toBe(true);
    expect((await availableActions(db, req, proc2)).length).toBe(0);
  });

  it('assigning a user without procurement rights is rejected', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head', 'procurement_head');
    const requester = await mk('req', 'requester', false);
    const created = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    const [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    await expect(
      performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: requester }),
    ).rejects.toThrow();
  });
});
