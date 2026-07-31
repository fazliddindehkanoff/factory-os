/**
 * PR3 — pilot golden path, end to end, on the deterministic seed:pilot data.
 *
 *   requester creates → director approves (PIN) → warehouse_check →
 *   warehouse receives and closes.
 *
 * Asserts: status walks the configured steps; exactly one stock movement (tagged
 * lifecycle); the balance is received once; a repeated receive is idempotent; and
 * the audit trail records the key events.
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
import { receiveStock } from './warehouse.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

const incomes = (db: any, requestId: string) =>
  db
    .select()
    .from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.requestId, requestId), eq(schema.stockMovements.movementType, 'income')));

describe('pilot golden path (seed:pilot)', () => {
  it('requester → director(PIN) → warehouse check → receive: one movement + audit trail', async () => {
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
    expect(r2.status).toBe('receiving');

    const r3 = await performAction(db, { requestId: req.id, action: 'receive_full', actor: { id: users.warehouse.id, holdingId: holding.id } });
    expect(r3.status).toBe('closed');
    expect(r3.currentStepId).toBeNull();

    // exactly one income movement, via the warehouse service (source 'lifecycle'); 100 → 105
    const moves = await incomes(db, req.id);
    expect(moves.length).toBe(1);
    expect(moves[0].source).toBe('lifecycle');
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, materials.inStock.id));
    expect(Number(bal.availableQty)).toBe(105);

    // repeated receive for the same request is idempotent — no double-write
    await receiveStock(db, { holdingId: holding.id, materialId: materials.inStock.id, quantity: 5, requestId: req.id });
    expect((await incomes(db, req.id)).length).toBe(1);

    // audit trail records the golden-path events
    const actions = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, req.id))).map((a: { action: string }) => a.action);
    for (const a of ['request.created', 'request.approve', 'request.wh_in_stock', 'request.receive_full']) {
      expect(actions).toContain(a);
    }
    const stockAudit = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'stock.received'), eq(schema.auditLogs.entityId, materials.inStock.id)));
    expect(stockAudit.length).toBe(1);
  });
});
