import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { receiveStock, issueStock, getBalance } from './warehouse.service.js';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [m] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Cotton' }).returning();
  return { db, holdingId: h.id, materialId: m.id };
}

describe('warehouse service (movement-driven balances)', () => {
  it('receive increases the balance and records an income movement', async () => {
    const { db, holdingId, materialId } = await freshDb();
    const r1 = await receiveStock(db, { holdingId, materialId, quantity: 100 });
    expect(r1.availableQty).toBe(100);
    const r2 = await receiveStock(db, { holdingId, materialId, quantity: 50 });
    expect(r2.availableQty).toBe(150);

    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.materialId, materialId));
    expect(moves.length).toBe(2);
    expect(moves.every((m) => m.movementType === 'income')).toBe(true);
  });

  it('issue decreases the balance and records an outcome movement', async () => {
    const { db, holdingId, materialId } = await freshDb();
    await receiveStock(db, { holdingId, materialId, quantity: 100 });
    const out = await issueStock(db, { holdingId, materialId, quantity: 30 });
    expect(out.availableQty).toBe(70);
    const bal = await getBalance(db, holdingId, materialId);
    expect(Number(bal.availableQty)).toBe(70);
    const moves = await db.select().from(schema.stockMovements);
    expect(moves.some((m) => m.movementType === 'outcome')).toBe(true);
  });

  it('refuses to issue more than available (no negative balance)', async () => {
    const { db, holdingId, materialId } = await freshDb();
    await receiveStock(db, { holdingId, materialId, quantity: 10 });
    await expect(issueStock(db, { holdingId, materialId, quantity: 50 })).rejects.toThrow(/Недостаточно/);
    // Balance unchanged and no outcome movement recorded.
    const bal = await getBalance(db, holdingId, materialId);
    expect(Number(bal.availableQty)).toBe(10);
    const out = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.movementType, 'outcome'));
    expect(out.length).toBe(0);
  });

  it('rejects non-positive quantities', async () => {
    const { db, holdingId, materialId } = await freshDb();
    await expect(receiveStock(db, { holdingId, materialId, quantity: 0 })).rejects.toThrow();
    await expect(receiveStock(db, { holdingId, materialId, quantity: Number.NaN })).rejects.toThrow();
  });
});
