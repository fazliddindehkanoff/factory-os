/** Department-head self-approval is skipped only for requests they personally create. */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  const roleId = async (code: string) => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id as string;
  };
  const [s1] = await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await roleId('dept_head') }).returning();
  const [s2] = await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 2, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId('director') }).returning();
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 3, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId('warehouse') });
  const mkUser = async (tg: string, roleCode: string) => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(roleCode), holdingId: holding.id });
    return u.id as string;
  };
  return { db, holding, factory, s1, s2, mkUser };
}

describe('bug #1: auto-skip the author own approval step', () => {
  it('skips the first approval step when the author is its only approver', async () => {
    const { db, holding, factory, s1, s2, mkUser } = await setup();
    // The author IS the sole dept_head. director is someone else.
    const author = await mkUser('author', 'dept_head');
    await mkUser('dir', 'director');

    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: author,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    // Landed on the director step (dept_head step skipped), not on step 1.
    expect(row.currentStepId).toBe(s2.id);
    expect(row.status).toBe('pending_approval');

    // Skip was recorded in history.
    const hist = await db.select().from(schema.requestStatusHistory).where(eq(schema.requestStatusHistory.requestId, req.id));
    expect(hist.some((h: any) => h.source === 'auto_skip')).toBe(true);

    // No pending approval was created for the skipped dept_head step.
    const aps = await db.select().from(schema.approvals).where(eq(schema.approvals.requestId, req.id));
    expect(aps.every((a: any) => a.workflowStepId !== s1.id)).toBe(true);
  });

  it('skips the department-head stage even when another department head exists', async () => {
    const { db, holding, factory, s2, mkUser } = await setup();
    const author = await mkUser('author', 'dept_head');
    await mkUser('other', 'dept_head'); // a second dept_head exists

    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: author,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(row.currentStepId).toBe(s2.id);
  });

  it('does NOT skip when an assistant creates on behalf of a department head', async () => {
    const { db, holding, factory, s1, mkUser } = await setup();
    const assistant = await mkUser('assistant', 'requester');
    const selectedRequester = await mkUser('head', 'dept_head');

    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: selectedRequester,
      creatorId: assistant,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(row.currentStepId).toBe(s1.id);
    const hist = await db.select().from(schema.requestStatusHistory).where(eq(schema.requestStatusHistory.requestId, req.id));
    expect(hist.find((h: any) => h.oldStatus === null && h.changedBy)?.changedBy).toBe(assistant);
    expect(hist.some((h: any) => h.source === 'auto_skip')).toBe(false);
  });
});
