/**
 * PR2 — warehouse/lifecycle correctness.
 *
 * Covers GPT's acceptance criteria:
 *  - a successful issue records exactly one stock movement;
 *  - a repeated request-linked issue is idempotent (no double-write);
 *  - insufficient stock blocks the workflow step and does NOT advance the request;
 *  - the warehouse service writes an audit event on success;
 *  - insufficient stock fails loud (throws) and writes no movement;
 *  - the lifecycle issue step goes through the same warehouse service path.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction } from './lifecycle.service.js';
import { issueStock } from './warehouse.service.js';
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
  const [r] = await db.select().from(schema.roles).where(eq(schema.roles.code, code));
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

/** Golden pilot path: approval(dept_head) → warehouse_check(wh) → issue(wh) → close(requester). */
async function seedGolden(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  const [mat] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
  const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Golden', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
    { workflowId: wf.id, stepOrder: 3, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId(db, 'warehouse') },
    { workflowId: wf.id, stepOrder: 4, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
  ]);
  return { h, f, mat };
}

async function setStock(db: any, holdingId: string, materialId: string, qty: number) {
  await db.insert(schema.stockBalances).values({ holdingId, materialId, availableQty: String(qty) });
}

async function newReq(db: any, h: any, f: any, requester: string, mat: any, qty: number) {
  return createRequest(db, {
    holdingId: h.id,
    requesterId: requester,
    factoryId: f.id,
    items: [{ name: mat.name, materialId: mat.id, quantity: qty, unitPrice: 100 }],
  });
}

const outcomes = (db: any, requestId: string) =>
  db
    .select()
    .from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.requestId, requestId), eq(schema.stockMovements.movementType, 'outcome')));

describe('warehouse service correctness', () => {
  it('a successful issue records exactly one movement and decrements the balance', async () => {
    const db = await setup();
    const { h, f, mat } = await seedGolden(db);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    await setStock(db, h.id, mat.id, 100);
    const req = await newReq(db, h, f, requester, mat, 10);

    const res = await issueStock(db, { holdingId: h.id, materialId: mat.id, quantity: 10, requestId: req.id, performedBy: requester });
    expect(res.availableQty).toBe(90);
    expect((await outcomes(db, req.id)).length).toBe(1);
  });

  it('a repeated request-linked issue is idempotent — no double-write', async () => {
    const db = await setup();
    const { h, f, mat } = await seedGolden(db);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    await setStock(db, h.id, mat.id, 100);
    const req = await newReq(db, h, f, requester, mat, 10);

    const first = await issueStock(db, { holdingId: h.id, materialId: mat.id, quantity: 10, requestId: req.id, performedBy: requester });
    expect(first.availableQty).toBe(90);
    const second = await issueStock(db, { holdingId: h.id, materialId: mat.id, quantity: 10, requestId: req.id, performedBy: requester });
    expect(second.idempotent).toBe(true);
    expect(second.availableQty).toBe(90); // unchanged
    expect((await outcomes(db, req.id)).length).toBe(1);
  });

  it('writes a stock.issued audit event on success', async () => {
    const db = await setup();
    const { h, mat } = await seedGolden(db);
    const u = await mkUser(db, h.id, 'warehouse', 'wh');
    await setStock(db, h.id, mat.id, 50);

    await issueStock(db, { holdingId: h.id, materialId: mat.id, quantity: 5, performedBy: u });
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, 'stock.issued'), eq(schema.auditLogs.entityId, mat.id)));
    expect(audits.length).toBe(1);
    expect(audits[0].module).toBe('warehouse');
  });

  it('insufficient stock fails loud and records no movement', async () => {
    const db = await setup();
    const { h, mat } = await seedGolden(db);
    const u = await mkUser(db, h.id, 'warehouse', 'wh');
    await setStock(db, h.id, mat.id, 2);

    await expect(
      issueStock(db, { holdingId: h.id, materialId: mat.id, quantity: 10, performedBy: u }),
    ).rejects.toThrow(/Недостаточно/);
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.materialId, mat.id));
    expect(moves.length).toBe(0);
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal.availableQty)).toBe(2);
  });
});

describe('lifecycle issue step', () => {
  async function walkToIssue(db: any, h: any, f: any, mat: any, stock: number, qty: number) {
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    await setStock(db, h.id, mat.id, stock);
    const req = await newReq(db, h, f, requester, mat, qty);
    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: dh, holdingId: h.id }, pin: PIN });
    const atIssue = await performAction(db, { requestId: req.id, action: 'wh_in_stock', actor: { id: wh, holdingId: h.id } });
    expect(atIssue.status).toBe('issue');
    return { req, wh, atIssue };
  }

  it('issues through the warehouse service (source=lifecycle) and advances', async () => {
    const db = await setup();
    const { h, f, mat } = await seedGolden(db);
    const { req, wh } = await walkToIssue(db, h, f, mat, 20, 5);

    const issued = await performAction(db, { requestId: req.id, action: 'issue', actor: { id: wh, holdingId: h.id } });
    expect(issued.status).toBe('close'); // advanced past the issue step

    const moves = await outcomes(db, req.id);
    expect(moves.length).toBe(1);
    expect(moves[0].source).toBe('lifecycle');
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal.availableQty)).toBe(15);
  });

  it('insufficient stock blocks the step — request does not advance and no movement is written', async () => {
    const db = await setup();
    const { h, f, mat } = await seedGolden(db);
    const { req, wh, atIssue } = await walkToIssue(db, h, f, mat, 1, 5);

    await expect(
      performAction(db, { requestId: req.id, action: 'issue', actor: { id: wh, holdingId: h.id } }),
    ).rejects.toThrow(/Недостаточно/);

    const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(r.status).toBe('issue'); // still on the issue step
    expect(r.currentStepId).toBe(atIssue.currentStepId);
    expect((await outcomes(db, req.id)).length).toBe(0);
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal.availableQty)).toBe(1);
  });
});
