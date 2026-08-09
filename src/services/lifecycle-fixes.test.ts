/**
 * Regression tests for the 2026-07-02 fix batch:
 *  - M4: separation of duties beyond 'approve' (mark_paid / select_supplier /
 *    warehouse verdict are money/routing decisions — not on one's own request);
 *  - B9: 'close' is the author's receipt confirmation, not any requests.create holder;
 *  - L4: add_quotation no longer swings estimatedAmount; only select_supplier locks it;
 *  - L3: a chain ending at 'issue' terminates as closed, not approved;
 *  - M3: items that cannot move stock produce an explicit warning;
 *  - M2: a workflow with TWO receiving steps applies stock twice (step-bound
 *    idempotency), while retrying one step stays a no-op;
 *  - M7: a factory-scoped role assignment still opens module endpoints.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { availableActions, performAction } from './lifecycle.service.js';
import { applyStockOp } from './warehouse.service.js';
import { hashPin } from '../auth/pin.js';
import { createApp } from '../server/app.js';

const PIN = '1234';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function mkUser(db: any, holdingId: string, roleCodes: string[], tg: string, withPin = false): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', ...(withPin ? { pinHash: hashPin(PIN) } : {}) })
    .returning();
  for (const code of roleCodes) {
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  }
  return u.id;
}
const acts = (list: { action: string }[]) => list.map((a) => a.action);
const reload = async (db: any, id: string) => {
  const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
  return r;
};

async function org(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  return { h, f };
}

describe('M4 — separation of duties beyond approve', () => {
  /** finance_payment(finance) → close(requester) */
  async function payFlow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Pay', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Оплата', stepKind: 'finance_payment', approverRoleId: await roleId(db, 'finance') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }

  it('a requester who also holds finance cannot mark their own request paid', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const both = await mkUser(db, h.id, ['requester', 'finance'], 'both', true);
    const req = await payFlow(db, h, f, both);

    expect(acts(await availableActions(db, req, both))).not.toContain('mark_paid');
    await expect(
      performAction(db, { requestId: req.id, action: 'mark_paid', actor: { id: both, holdingId: h.id }, pin: PIN }),
    ).rejects.toThrow(/собственной заявке/);
  });

  it('another finance user still can', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const fin = await mkUser(db, h.id, ['finance'], 'fin', true);
    const req = await payFlow(db, h, f, requester);

    const r = await performAction(db, { requestId: req.id, action: 'mark_paid', actor: { id: fin, holdingId: h.id }, pin: PIN });
    expect(r.status).toBe('close');
  });
});

describe('B9 — close is the author-only receipt confirmation', () => {
  /** close(requester) as the only step. */
  async function closeFlow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Close', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }

  it("a stranger with requests.create cannot close someone else's request", async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const author = await mkUser(db, h.id, ['requester'], 'author');
    const stranger = await mkUser(db, h.id, ['requester'], 'stranger');
    const req = await closeFlow(db, h, f, author);

    expect(acts(await availableActions(db, req, stranger))).not.toContain('close');
    await expect(
      performAction(db, { requestId: req.id, action: 'close', actor: { id: stranger, holdingId: h.id } }),
    ).rejects.toThrow(/автор заявки/);

    const r = await performAction(db, { requestId: req.id, action: 'close', actor: { id: author, holdingId: h.id } });
    expect(r.status).toBe('closed');
  });
});

describe('L4 — estimatedAmount is locked by the single approved proposal path', () => {
  it('add_quotation auto-selects the proposal and sets the real amount', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const proc = await mkUser(db, h.id, ['procurement'], 'proc');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Proc', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    const req = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 2, unitPrice: 1000 }] });
    expect(req.estimatedAmount).toBe(2000);

    const r = await performAction(db, { requestId: req.id, action: 'add_quotation', actor: { id: proc, holdingId: h.id }, supplierName: 'A', amount: 5000 });
    expect(r.estimatedAmount).toBe(5000);
    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
    expect(q.selected).toBe(true);
  });
});

describe('L3 + M3 + M2 — stock steps: terminal status, warnings, step-bound idempotency', () => {
  it('a chain ending at issue terminates as closed; free-text items warn and move nothing', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'IssueEnd', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId(db, 'warehouse') },
    ]);
    // Free-text item (no materialId) — nothing to move on the issue step.
    const req = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'Custom', quantity: 3, unitPrice: 10 }] });

    const r = await performAction(db, { requestId: req.id, action: 'issue', actor: { id: wh, holdingId: h.id } });
    expect(r.status).toBe('closed'); // L3: issue-terminated chain is CLOSED
    expect(r.warnings.join(' ')).toMatch(/Custom/); // M3: explicit warning
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestId, req.id));
    expect(moves.length).toBe(0);
  });

  it('two receiving steps each move stock; a retry of the same step is a no-op', async () => {
    const db = await setup();
    const { h } = await org(db);
    const [mat] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'TwoRecv', isActive: true }).returning();
    const steps = await db
      .insert(schema.workflowSteps)
      .values([
        { workflowId: wf.id, stepOrder: 1, stepName: 'Приёмка 1', stepKind: 'receiving', approverRoleId: await roleId(db, 'warehouse') },
        { workflowId: wf.id, stepOrder: 2, stepName: 'Приёмка 2', stepKind: 'receiving', approverRoleId: await roleId(db, 'warehouse') },
      ])
      .returning();
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const req = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      items: [{ name: 'Болт', materialId: mat.id, quantity: 10, unitPrice: 5 }],
    });

    const base = { holdingId: h.id, materialId: mat.id, quantity: 10, requestId: req.id, source: 'lifecycle' };
    await db.transaction((tx: any) => applyStockOp(tx, { ...base, workflowStepId: steps[0].id }, 'income'));
    // Retry of the SAME step → idempotent no-op.
    const retry = await db.transaction((tx: any) => applyStockOp(tx, { ...base, workflowStepId: steps[0].id }, 'income'));
    expect(retry.idempotent).toBe(true);
    // A DIFFERENT receiving step legitimately applies again (M2).
    const second = await db.transaction((tx: any) => applyStockOp(tx, { ...base, workflowStepId: steps[1].id }, 'income'));
    expect(second.idempotent).toBeUndefined();
    expect(second.availableQty).toBe(20);
    // A manual op after lifecycle ones is still deduped (design intent preserved).
    const manual = await db.transaction((tx: any) => applyStockOp(tx, base, 'income'));
    expect(manual.idempotent).toBe(true);
  });
});

describe('M7 — factory-scoped assignments open module endpoints', () => {
  it('a requester assigned at factory scope can list and create requests', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    // Assignment narrowed to the factory (as the admin panel allows).
    const [u] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, fullName: 'narrow', telegramId: 'narrow', status: 'active' })
      .returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, 'requester'), holdingId: h.id, factoryId: f.id });

    const app = createApp({ db, botToken: 'test:token', sessionSecret: 'test-secret-long-enough', devAuth: true });
    const tk = (await request(app).post('/api/auth/dev').send({ telegramId: 'narrow' }).expect(200)).body.token as string;

    await request(app).get('/api/requests').set('Authorization', `Bearer ${tk}`).expect(200);
    const created = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${tk}`)
      .send({ factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] })
      .expect(201);
    expect(created.body.requestNumber).toMatch(/^REQ-/);
  });
});
