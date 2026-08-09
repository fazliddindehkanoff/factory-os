/**
 * Data-driven lifecycle: a request walks the steps configured for its workflow,
 * each step's available actions come from its KIND, branching follows conditions,
 * and approval steps are gated by the step's approver role. This is the test that
 * pins the behaviour the admin constructor is supposed to drive end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { availableActions, performAction } from './lifecycle.service.js';
import { hashPin } from '../auth/pin.js';

const PIN = '1234';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

async function mkUser(db: any, holdingId: string, roleCode: string, tg: string, withPin = false): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, ...(withPin ? { pinHash: hashPin(PIN) } : {}) })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, roleCode), holdingId });
  return u.id;
}

/** Build a holding + a 5-step, multi-kind workflow:
 *  approval(dept_head) → warehouse_check → procurement(if !inStock) → finance_payment → close */
async function seedOrg(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  const [wf] = await db
    .insert(schema.workflows)
    .values({ holdingId: h.id, name: 'Full', isActive: true })
    .returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
    { workflowId: wf.id, stepOrder: 3, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement'), conditionRule: { inStock: false } },
    { workflowId: wf.id, stepOrder: 4, stepName: 'Оплата', stepKind: 'finance_payment', approverRoleId: await roleId(db, 'finance') },
    { workflowId: wf.id, stepOrder: 5, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
  ]);
  return { h, f, wf };
}

async function newRequest(db: any, h: any, f: any, requesterId: string, creatorId?: string) {
  return createRequest(db, {
    holdingId: h.id,
    requesterId,
    creatorId,
    factoryId: f.id,
    items: [{ name: 'X', quantity: 2, unitPrice: 1000 }],
  });
}

const acts = (list: { action: string }[]) => list.map((a) => a.action);

describe('data-driven lifecycle', () => {
  it('walks the whole configured path; in-stock skips procurement → closed', async () => {
    const db = await setup();
    const { h, f } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const fin = await mkUser(db, h.id, 'finance', 'fin', true);

    const req = await newRequest(db, h, f, requester);
    expect(req.status).toBe('pending_approval');

    // Step 1 (approval, dept_head): only dh may approve; warehouse cannot.
    expect(acts(await availableActions(db, req, dh))).toContain('approve');
    expect(acts(await availableActions(db, req, wh))).not.toContain('approve');

    const r1 = await performAction(db, { requestId: req.id, action: 'approve', actor: { id: dh, holdingId: h.id }, pin: PIN });
    expect(r1.status).toBe('warehouse_check');

    // Step 2 (warehouse_check): mark in-stock → procurement (step 3) is skipped.
    const r2 = await performAction(db, { requestId: req.id, action: 'wh_in_stock', actor: { id: wh, holdingId: h.id } });
    expect(r2.inStock).toBe(true);
    expect(r2.status).toBe('finance_payment');

    // Step 4 (finance_payment): pay → close (step 5).
    const r3 = await performAction(db, { requestId: req.id, action: 'mark_paid', actor: { id: fin, holdingId: h.id }, pin: PIN });
    expect(r3.status).toBe('close');

    // Step 5 (close): requester confirms → terminal.
    const r4 = await performAction(db, { requestId: req.id, action: 'close', actor: { id: requester, holdingId: h.id } });
    expect(r4.status).toBe('closed');
    expect(r4.currentStepId).toBeNull();
  });

  it('out-of-stock routes through procurement (КП + supplier)', async () => {
    const db = await setup();
    const { h, f } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const proc = await mkUser(db, h.id, 'procurement', 'proc');
    // Выбор поставщика — только у руководителя снабжения (2026-07-06).
    const procHead = await mkUser(db, h.id, 'procurement_head', 'ph');

    const req = await newRequest(db, h, f, requester);
    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: dh, holdingId: h.id }, pin: PIN });
    const r2 = await performAction(db, { requestId: req.id, action: 'wh_out_of_stock', actor: { id: wh, holdingId: h.id } });
    expect(r2.inStock).toBe(false);
    expect(r2.status).toBe('procurement');

    // The single proposal is auto-selected and advances.
    const r3 = await performAction(db, { requestId: req.id, action: 'add_quotation', actor: { id: proc, holdingId: h.id }, supplierName: 'ООО Поставка', amount: 5000 });
    expect(r3.status).toBe('finance_payment');
    expect(r3.estimatedAmount).toBe(5000);
  });

  it('rejecting at any step ends the request as rejected', async () => {
    const db = await setup();
    const { h, f } = await seedOrg(db);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);

    const req = await newRequest(db, h, f, requester);
    await expect(
      performAction(db, { requestId: req.id, action: 'reject', actor: { id: dh, holdingId: h.id }, comment: '' }),
    ).rejects.toThrow();
    const r = await performAction(db, { requestId: req.id, action: 'reject', actor: { id: dh, holdingId: h.id }, comment: 'нет бюджета' });
    expect(r.status).toBe('rejected');
    expect(r.currentStepId).toBeNull();
  });

  it('forbids self-approval even with the approver role', async () => {
    const db = await setup();
    const { h, f } = await seedOrg(db);
    // requester also holds dept_head + a PIN.
    const both = await mkUser(db, h.id, 'requester', 'both', true);
    await db.insert(schema.userRoles).values({ userId: both, roleId: await roleId(db, 'dept_head'), holdingId: h.id });
    // An assistant created this request on the department head's behalf, so the
    // department-head step stays live; the selected requester still cannot approve it.
    const assistant = await mkUser(db, h.id, 'requester', 'assistant');

    const req = await newRequest(db, h, f, both, assistant);
    expect(acts(await availableActions(db, req, both))).not.toContain('approve');
    await expect(
      performAction(db, { requestId: req.id, action: 'approve', actor: { id: both, holdingId: h.id }, pin: PIN }),
    ).rejects.toThrow(/собственную заявку/);
  });
});
