/**
 * Warehouse service — the SINGLE authoritative path for stock mutations.
 *
 * Every quantity change goes through a stock movement recorded in the ledger AND
 * a balance update, atomically in one transaction — never a silent balance edit.
 * Issue refuses to go below available stock (fail-loud: throws, the caller's
 * transaction rolls back). Request-linked ops are idempotent: a given
 * (requestId, materialId, movementType) is applied at most once, so a retry or a
 * duplicate call (e.g. the lifecycle step and a manual /warehouse action) can
 * never double-write the same movement.
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { ValidationError } from './errors.js';
import { logger } from '../http/logger.js';

type Db = any;

export interface StockOp {
  holdingId: string;
  materialId: string;
  warehouseId?: string | null;
  quantity: number;
  performedBy?: string | null;
  requestId?: string | null;
  reason?: string | null;
  /** Origin recorded on the movement and audit (e.g. 'api', 'lifecycle'). */
  source?: string;
}

export interface StockResult {
  balanceId: string;
  availableQty: number;
  /** True when a request-linked op was a no-op because it was already applied. */
  idempotent?: boolean;
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

/** A request-linked movement of this type already recorded? (idempotency key) */
async function existingRequestMovement(tx: Db, p: StockOp, type: 'income' | 'outcome') {
  if (!p.requestId) return null;
  const [m] = await tx
    .select()
    .from(schema.stockMovements)
    .where(
      and(
        eq(schema.stockMovements.requestId, p.requestId),
        eq(schema.stockMovements.materialId, p.materialId),
        eq(schema.stockMovements.movementType, type),
      ),
    );
  return m ?? null;
}

async function applyStock(db: Db, p: StockOp, type: 'income' | 'outcome'): Promise<StockResult> {
  assertQty(p.quantity, 'Количество должно быть положительным числом');
  return db.transaction(async (tx: Db) => {
    const balance = await findOrCreateBalance(tx, p.holdingId, p.materialId, p.warehouseId);

    // Idempotency: a request-linked op is applied at most once → no double-write.
    const dup = await existingRequestMovement(tx, p, type);
    if (dup) {
      return { balanceId: balance.id, availableQty: Number(balance.availableQty), idempotent: true };
    }

    if (type === 'outcome' && Number(balance.availableQty) < p.quantity) {
      // Fail-loud: visible error event in the log, then throw so the caller's
      // transaction rolls back and the workflow step does NOT advance.
      logger.warn('warehouse.issue_failed', {
        holdingId: p.holdingId,
        materialId: p.materialId,
        requested: p.quantity,
        available: Number(balance.availableQty),
        requestId: p.requestId ?? null,
      });
      throw new ValidationError('Недостаточно остатка на складе');
    }

    await tx.insert(schema.stockMovements).values({
      holdingId: p.holdingId,
      warehouseId: p.warehouseId ?? null,
      materialId: p.materialId,
      movementType: type,
      quantity: String(p.quantity),
      requestId: p.requestId ?? null,
      performedBy: p.performedBy ?? null,
      reason: p.reason ?? null,
      source: p.source ?? 'api',
    });

    const next =
      type === 'income'
        ? Number(balance.availableQty) + p.quantity
        : Number(balance.availableQty) - p.quantity;
    await tx
      .update(schema.stockBalances)
      .set({ availableQty: String(next), updatedAt: new Date() })
      .where(eq(schema.stockBalances.id, balance.id));

    await tx.insert(schema.auditLogs).values({
      holdingId: p.holdingId,
      userId: p.performedBy ?? null,
      action: type === 'income' ? 'stock.received' : 'stock.issued',
      module: 'warehouse',
      entityType: 'material',
      entityId: p.materialId,
      newValue: {
        quantity: p.quantity,
        availableQty: next,
        requestId: p.requestId ?? null,
        warehouseId: p.warehouseId ?? null,
      },
      source: p.source ?? 'api',
    });

    return { balanceId: balance.id, availableQty: next };
  });
}

export function receiveStock(db: Db, p: StockOp): Promise<StockResult> {
  return applyStock(db, p, 'income');
}

export function issueStock(db: Db, p: StockOp): Promise<StockResult> {
  return applyStock(db, p, 'outcome');
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
