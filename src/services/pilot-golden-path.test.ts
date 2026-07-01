/**
 * PR3 — pilot golden path, end to end, on the deterministic seed:pilot data.
 *
 *   requester creates → director approves (PIN) → warehouse_check →
 *   warehouse issues → requester closes.
 *
 * Asserts: status walks the configured steps; exactly one stock movement (tagged
 * lifecycle); the balance drops once; a repeated issue is idempotent; the audit
 * trail records the key events; and the insufficient-stock path fails loud
 * (step blocked, request not advanced, no movement, balance intact).
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedPilot, PILOT_PIN } from '../db/seed-pilot.js';
import { createRequest } from './request.service.js';
import { performAction } from './lifecycle.service.js';
import { issueStock } from './warehouse.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

const outcomes = (db: any, requestId: string) =>
  db
    .select()
    .from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.requestId, requestId), eq(schema.stockMovements.movementType, 'outcome')));

describe('pilot golden path (seed:pilot)', () => {
  it('requester → director(PIN) → warehouse check → issue → close: one movement + audit trail', async () => {
    const db = await setup();
    const { holding, factory, users, materials } = await seedPilot(db);

    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: users.requester.id,
      factoryId: factory.id,
      items: [{ name: materials.inStock.name, materialId: materials.inStock.id, quantity: 5, unitPrice: 1000 }],
    });
    expect(req.status).toBe('pending_approval');

    const r1 = await performAction(db, { requestId: req.id, action: 'approve', actor: { id: users.director.id, holdingId: holding.id }, pin: PILOT_PIN });
    expect(r1.status).toBe('warehouse_check');

    const r2 = await performAction(db, { requestId: req.id, action: 'wh_in_stock', actor: { id: users.warehouse.id, holdingId: holding.id } });
    expect(r2.status).toBe('issue');

    const r3 = await performAction(db, { requestId: req.id, action: 'issue', actor: { id: users.warehouse.id, holdingId: holding.id } });
    expect(r3.status).toBe('close');

    const r4 = await performAction(db, { requestId: req.id, action: 'close', actor: { id: users.requester.id, holdingId: holding.id } });
    expect(r4.status).toBe('closed');
    expect(r4.currentStepId).toBeNull();

    // exactly one outcome movement, via the warehouse service (source 'lifecycle'); 100 → 95
    const moves = await outcomes(db, req.id);
    expect(moves.length).toBe(1);
    expect(moves[0].source).toBe('lifecycle');
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, materials.inStock.id));
    expect(Number(bal.availableQty)).toBe(95);

    // repeated issue for the same request is idempotent — no double-write
    await issueStock(db, { holdingId: holding.id, materialId: materials.inStock.id, quantity: 5, requestId: req.id });
    expect((await outcomes(db, req.id)).length).toBe(1);

    // audit trail records the golden-path events
    const actions = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, req.id))).map((a: { action: string }) => a.action);
    for (const a of ['request.created', 'request.approve', 'request.wh_in_stock', 'request.issue', 'request.close']) {
      expect(actions).toContain(a);
    }
    const stockAudit = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'stock.issued'), eq(schema.auditLogs.entityId, materials.inStock.id)));
    expect(stockAudit.length).toBe(1);
  });

  it('insufficient stock blocks the issue step — request stays, no movement (fail-loud)', async () => {
    const db = await setup();
    const { holding, factory, users, materials } = await seedPilot(db);

    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: users.requester.id,
      factoryId: factory.id,
      items: [{ name: materials.lowStock.name, materialId: materials.lowStock.id, quantity: 5, unitPrice: 1000 }],
    });
    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: users.director.id, holdingId: holding.id }, pin: PILOT_PIN });
    const atIssue = await performAction(db, { requestId: req.id, action: 'wh_in_stock', actor: { id: users.warehouse.id, holdingId: holding.id } });
    expect(atIssue.status).toBe('issue');

    await expect(
      performAction(db, { requestId: req.id, action: 'issue', actor: { id: users.warehouse.id, holdingId: holding.id } }),
    ).rejects.toThrow(/Недостаточно/);

    const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(r.status).toBe('issue');
    expect(r.currentStepId).toBe(atIssue.currentStepId);
    expect((await outcomes(db, req.id)).length).toBe(0);
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, materials.lowStock.id));
    expect(Number(bal.availableQty)).toBe(1);
  });
});
