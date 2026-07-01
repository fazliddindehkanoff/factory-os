import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { approveApproval, rejectApproval } from './approval.service.js';

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}
async function mkUser(db: any, holdingId: string, name: string, tg: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: name, telegramId: tg })
    .returning();
  return u.id;
}
async function pendingApproval(db: any, requestId: string): Promise<string> {
  const [a] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.requestId, requestId), eq(schema.approvals.status, 'pending')));
  return a.id;
}

/** Org with a 2-step workflow: step1 = dept_head role, step2 = warehouse role. */
async function seedOrg(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  const deptHeadRole = await roleId(db, 'dept_head');
  const warehouseRole = await roleId(db, 'warehouse');
  const [wf] = await db
    .insert(schema.workflows)
    .values({ holdingId: h.id, name: 'Default', isActive: true })
    .returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', approverRoleId: deptHeadRole },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', approverRoleId: warehouseRole },
  ]);
  return { h, f, deptHeadRole, warehouseRole };
}

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}

describe('createRequest', () => {
  it('creates an atomic request with a year-scoped number, items, and the first approval', async () => {
    const db = await setup();
    const { h, f } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'Requester', 'r1');

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [
        { name: 'Cotton', quantity: 2, unitPrice: 1000 },
        { name: 'Dye', quantity: 1, unitPrice: 500 },
      ],
    });

    expect(req.requestNumber).toMatch(/^REQ-\d{4}-00001$/);
    expect(req.status).toBe('pending_approval');
    expect(req.estimatedAmount).toBe(2500);

    const items = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    expect(items.length).toBe(2);
    const pend = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
    expect(pend.length).toBe(1);

    // Second request increments the sequence within the year.
    const req2 = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      items: [{ name: 'X', quantity: 1, unitPrice: 1 }],
    });
    expect(req2.requestNumber).toMatch(/^REQ-\d{4}-00002$/);
  });

  it('rejects non-finite numbers (items are otherwise optional by design)', async () => {
    const db = await setup();
    const { h } = await seedOrg(db);
    const u = await mkUser(db, h.id, 'R', 'r2');
    // Empty items is allowed: an admin can build a fully-custom form with no item grid.
    await expect(createRequest(db, { holdingId: h.id, requesterId: u, items: [] })).resolves.toBeTruthy();
    // A named item with a non-finite quantity is rejected.
    await expect(
      createRequest(db, {
        holdingId: h.id,
        requesterId: u,
        items: [{ name: 'X', quantity: Number.NaN, unitPrice: 10 }],
      }),
    ).rejects.toThrow();
  });
});

describe('approval flow', () => {
  it('advances through the chain and terminates as approved', async () => {
    const db = await setup();
    const { h, f, deptHeadRole, warehouseRole } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'Requester', 'r1');
    const dh = await mkUser(db, h.id, 'DeptHead', 'dh1');
    const wh = await mkUser(db, h.id, 'Warehouse', 'wh1');
    await db.insert(schema.userRoles).values({ userId: dh, roleId: deptHeadRole, holdingId: h.id, factoryId: f.id });
    await db.insert(schema.userRoles).values({ userId: wh, roleId: warehouseRole, holdingId: h.id, factoryId: f.id });

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [{ name: 'X', quantity: 2, unitPrice: 1000 }],
    });

    const a1 = await pendingApproval(db, req.id);
    // Wrong authority: warehouse user cannot clear the dept_head step.
    await expect(approveApproval(db, { approvalId: a1, actorUserId: wh })).rejects.toThrow();
    // Correct authority advances to step 2.
    const r1 = await approveApproval(db, { approvalId: a1, actorUserId: dh });
    expect(r1.status).toBe('pending_approval');
    expect(r1.nextStepId).toBeTruthy();
    // Idempotency: the same approval cannot be processed twice.
    await expect(approveApproval(db, { approvalId: a1, actorUserId: dh })).rejects.toThrow();

    const a2 = await pendingApproval(db, req.id);
    const r2 = await approveApproval(db, { approvalId: a2, actorUserId: wh });
    expect(r2.status).toBe('approved');
    expect(r2.nextStepId).toBeNull();

    const [fresh] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(fresh.status).toBe('approved');
  });

  it('forbids self-approval even when the actor has the approver role (separation of duties)', async () => {
    const db = await setup();
    const { h, f, deptHeadRole } = await seedOrg(db);
    // This user is BOTH the requester and a dept_head.
    const dh = await mkUser(db, h.id, 'DeptHeadWhoRequests', 'dh2');
    await db.insert(schema.userRoles).values({ userId: dh, roleId: deptHeadRole, holdingId: h.id, factoryId: f.id });

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: dh,
      factoryId: f.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    const a1 = await pendingApproval(db, req.id);
    await expect(approveApproval(db, { approvalId: a1, actorUserId: dh })).rejects.toThrow(
      /собственную заявку/,
    );
  });

  it('rejects a request (with mandatory comment) and forbids empty reasons', async () => {
    const db = await setup();
    const { h, f, deptHeadRole } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'Requester', 'r3');
    const dh = await mkUser(db, h.id, 'DeptHead', 'dh3');
    await db.insert(schema.userRoles).values({ userId: dh, roleId: deptHeadRole, holdingId: h.id, factoryId: f.id });

    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    const a1 = await pendingApproval(db, req.id);

    await expect(rejectApproval(db, { approvalId: a1, actorUserId: dh, comment: '' })).rejects.toThrow();
    const r = await rejectApproval(db, { approvalId: a1, actorUserId: dh, comment: 'нет бюджета' });
    expect(r.status).toBe('rejected');
    const [fresh] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(fresh.status).toBe('rejected');
  });
});
