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
import { and, eq, isNull, or, sql } from 'drizzle-orm';
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
  /** Workflow step that triggered a lifecycle op — part of the idempotency key (M2). */
  workflowStepId?: string | null;
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
  // Acquire row lock to prevent duplicate balance rows from concurrent inserts.
  const whCond = warehouseId
    ? eq(schema.stockBalances.warehouseId, warehouseId)
    : isNull(schema.stockBalances.warehouseId);
  await tx.execute(sql`
    SELECT 1 FROM stock_balances
    WHERE holding_id = ${holdingId}
      AND material_id = ${materialId}
      AND ${warehouseId ? sql`warehouse_id = ${warehouseId}` : sql`warehouse_id IS NULL`}
    FOR UPDATE`);
  // Use Drizzle select (returns camelCase fields)
  const [existing] = await tx
    .select()
    .from(schema.stockBalances)
    .where(
      and(
        eq(schema.stockBalances.holdingId, holdingId),
        eq(schema.stockBalances.materialId, materialId),
        whCond,
      ),
    );
  if (existing) return existing;
  // Concurrent first-receives race here: the partial unique indexes on
  // stock_balances make the loser fail with 23505 — re-read the winner's row
  // instead of splitting the balance across duplicates. (B8)
  try {
    const [created] = await tx
      .insert(schema.stockBalances)
      .values({ holdingId, materialId, warehouseId: warehouseId ?? null })
      .returning();
    return created;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== '23505') throw e;
    const [row] = await tx
      .select()
      .from(schema.stockBalances)
      .where(
        and(
          eq(schema.stockBalances.holdingId, holdingId),
          eq(schema.stockBalances.materialId, materialId),
          whCond,
        ),
      );
    return row;
  }
}

/**
 * A request-linked movement of this type already recorded? (idempotency key)
 * The key is scoped to the warehouse POOL (a movement in a named warehouse and one
 * in the default NULL pool are different operations — E2) and to the WORKFLOW STEP:
 *  - a lifecycle op (step set) is a duplicate of the SAME step or of a manual
 *    (step-null) movement in the same pool — a manual receive still "counts" for
 *    the lifecycle step, and retrying a step is a no-op;
 *  - two DIFFERENT steps each get their own movement (a workflow may legitimately
 *    hold two receiving/issue steps — M2);
 *  - a manual op (step null) is a duplicate of ANY movement in the pool.
 */
async function existingRequestMovement(tx: Db, p: StockOp, type: 'income' | 'outcome') {
  if (!p.requestId) return null;
  const conds = [
    eq(schema.stockMovements.requestId, p.requestId),
    eq(schema.stockMovements.materialId, p.materialId),
    eq(schema.stockMovements.movementType, type),
    p.warehouseId
      ? eq(schema.stockMovements.warehouseId, p.warehouseId)
      : isNull(schema.stockMovements.warehouseId),
  ];
  if (p.workflowStepId) {
    conds.push(
      or(
        eq(schema.stockMovements.workflowStepId, p.workflowStepId),
        isNull(schema.stockMovements.workflowStepId),
      )!,
    );
  }
  const [m] = await tx.select().from(schema.stockMovements).where(and(...conds));
  return m ?? null;
}

/**
 * Core stock operation — runs inside an ALREADY-OPEN transaction (`tx`).
 * Use this from lifecycle (which owns its own transaction) to avoid nested tx.
 * For standalone callers, use `receiveStock` / `issueStock` which wrap in a tx.
 */
export async function applyStockOp(tx: Db, p: StockOp, type: 'income' | 'outcome'): Promise<StockResult> {
  assertQty(p.quantity, 'Количество должно быть положительным числом');

  const balance = await findOrCreateBalance(tx, p.holdingId, p.materialId, p.warehouseId);

  // Idempotency: a request-linked op is applied at most once → no double-write.
  const dup = await existingRequestMovement(tx, p, type);
  if (dup) {
    return { balanceId: balance.id, availableQty: Number(balance.availableQty), idempotent: true };
  }

  await tx.insert(schema.stockMovements).values({
    holdingId: p.holdingId,
    warehouseId: p.warehouseId ?? null,
    materialId: p.materialId,
    movementType: type,
    quantity: String(p.quantity),
    requestId: p.requestId ?? null,
    workflowStepId: p.workflowStepId ?? null,
    performedBy: p.performedBy ?? null,
    reason: p.reason ?? null,
    source: p.source ?? 'api',
  });

  // Atomic balance update — no read-modify-write race.
  if (type === 'outcome') {
    const upd = await tx.execute(sql`
      UPDATE stock_balances
      SET available_qty = available_qty - ${p.quantity}::numeric,
          updated_at = now()
      WHERE id = ${balance.id}
        AND available_qty >= ${p.quantity}::numeric
      RETURNING *`);
    if (upd.rows.length === 0) {
      logger.warn('warehouse.issue_failed', {
        holdingId: p.holdingId,
        materialId: p.materialId,
        requested: p.quantity,
        available: Number(balance.availableQty),
        requestId: p.requestId ?? null,
      });
      throw new ValidationError('Недостаточно остатка на складе');
    }
    const updRow = upd.rows[0] as any;
    const next = Number(updRow.available_qty ?? updRow.availableQty);

    await tx.insert(schema.auditLogs).values({
      holdingId: p.holdingId,
      userId: p.performedBy ?? null,
      action: 'stock.issued',
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
  } else {
    const upd = await tx.execute(sql`
      UPDATE stock_balances
      SET available_qty = available_qty + ${p.quantity}::numeric,
          updated_at = now()
      WHERE id = ${balance.id}
      RETURNING *`);
    const updRow2 = upd.rows[0] as any;
    const next = Number(updRow2.available_qty ?? updRow2.availableQty);

    await tx.insert(schema.auditLogs).values({
      holdingId: p.holdingId,
      userId: p.performedBy ?? null,
      action: 'stock.received',
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
  }
}

/** Standalone receive — wraps in its own transaction. */
export function receiveStock(db: Db, p: StockOp): Promise<StockResult> {
  return db.transaction((tx: Db) => applyStockOp(tx, p, 'income'));
}

/** Standalone issue — wraps in its own transaction. */
export function issueStock(db: Db, p: StockOp): Promise<StockResult> {
  return db.transaction((tx: Db) => applyStockOp(tx, p, 'outcome'));
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
