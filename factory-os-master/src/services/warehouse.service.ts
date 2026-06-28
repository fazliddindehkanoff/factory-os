/**
 * Warehouse service. Every quantity change goes through a stock movement recorded
 * in the ledger AND a balance update, atomically in one transaction — never a
 * silent balance edit (the legacy app violated this). Issue refuses to go below
 * available stock.
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { ValidationError } from './errors.js';

type Db = any;

export interface StockOp {
  holdingId: string;
  materialId: string;
  warehouseId?: string | null;
  quantity: number;
  performedBy?: string | null;
  requestId?: string | null;
  reason?: string | null;
}

function assertQty(q: number, message: string): void {
  if (!Number.isFinite(q) || q <= 0) throw new ValidationError(message);
}

async function findOrCreateBalance(tx: Db, holdingId: string, materialId: string, warehouseId?: string | null) {
  const where = and(
    eq(schema.stockBalances.holdingId, holdingId),
    eq(schema.stockBalances.materialId, materialId),
    warehouseId
      ? eq(schema.stockBalances.warehouseId, warehouseId)
      : isNull(schema.stockBalances.warehouseId),
  );
  const [existing] = await tx.select().from(schema.stockBalances).where(where);
  if (existing) return existing;
  const [created] = await tx
    .insert(schema.stockBalances)
    .values({ holdingId, materialId, warehouseId: warehouseId ?? null })
    .returning();
  return created;
}

async function recordMovement(
  tx: Db,
  p: StockOp,
  type: 'income' | 'outcome' | 'adjustment',
): Promise<void> {
  await tx.insert(schema.stockMovements).values({
    holdingId: p.holdingId,
    warehouseId: p.warehouseId ?? null,
    materialId: p.materialId,
    movementType: type,
    quantity: String(p.quantity),
    requestId: p.requestId ?? null,
    performedBy: p.performedBy ?? null,
    reason: p.reason ?? null,
    source: 'api',
  });
}

export async function receiveStock(db: Db, p: StockOp) {
  assertQty(p.quantity, 'Количество должно быть положительным числом');
  return db.transaction(async (tx: Db) => {
    await recordMovement(tx, p, 'income');
    const balance = await findOrCreateBalance(tx, p.holdingId, p.materialId, p.warehouseId);
    const next = Number(balance.availableQty) + p.quantity;
    await tx
      .update(schema.stockBalances)
      .set({ availableQty: String(next), updatedAt: new Date() })
      .where(eq(schema.stockBalances.id, balance.id));
    return { balanceId: balance.id, availableQty: next };
  });
}

export async function issueStock(db: Db, p: StockOp) {
  assertQty(p.quantity, 'Количество должно быть положительным числом');
  return db.transaction(async (tx: Db) => {
    const balance = await findOrCreateBalance(tx, p.holdingId, p.materialId, p.warehouseId);
    if (Number(balance.availableQty) < p.quantity) {
      throw new ValidationError('Недостаточно остатка на складе');
    }
    await recordMovement(tx, p, 'outcome');
    const next = Number(balance.availableQty) - p.quantity;
    await tx
      .update(schema.stockBalances)
      .set({ availableQty: String(next), updatedAt: new Date() })
      .where(eq(schema.stockBalances.id, balance.id));
    return { balanceId: balance.id, availableQty: next };
  });
}

export async function getBalance(db: Db, holdingId: string, materialId: string, warehouseId?: string | null) {
  const where = and(
    eq(schema.stockBalances.holdingId, holdingId),
    eq(schema.stockBalances.materialId, materialId),
    warehouseId
      ? eq(schema.stockBalances.warehouseId, warehouseId)
      : isNull(schema.stockBalances.warehouseId),
  );
  const [b] = await db.select().from(schema.stockBalances).where(where);
  return b ?? null;
}
