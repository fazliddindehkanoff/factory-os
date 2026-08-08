/**
 * Request service — creating a request atomically: number, items, the first
 * approval, status history and audit, all in one transaction. The request number
 * is year-scoped and NaN-safe (fixing the legacy generator), and the workflow +
 * first step are chosen by the data-driven engine, not hardcoded.
 */
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { initialPlacement } from './lifecycle.service.js';
import { statusForStep } from '../workflow/step-kinds.js';
import { ValidationError, ConflictError } from './errors.js';

type Db = any;

export interface CreateRequestItem {
  name: string;
  materialId?: string | null;
  quantity: number;
  unitPrice: number;
  unit?: string | null;
  description?: string | null;
  paymentType?: string | null;
  ndsIncluded?: boolean;
}

export interface CreateRequestInput {
  holdingId: string;
  requesterId: string;
  /** Real actor creating the request when submitted on another user's behalf. */
  creatorId?: string;
  companyId?: string | null;
  factoryId?: string | null;
  departmentId?: string | null;
  requestType?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
  title?: string;
  description?: string;
  departmentName?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  neededDate?: Date | null;
  customFields?: Record<string, unknown> | null;
  items: CreateRequestItem[];
}

function assertFiniteNonNeg(n: number, message: string): void {
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(message);
}

export async function generateRequestNumber(tx: Db, holdingId: string, year: number): Promise<string> {
  const prefix = `REQ-${year}-`;
  const rows: { rn: string }[] = await tx
    .select({ rn: schema.requests.requestNumber })
    .from(schema.requests)
    .where(
      and(eq(schema.requests.holdingId, holdingId), like(schema.requests.requestNumber, `${prefix}%`)),
    );
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.rn);
    if (m) {
      const seq = parseInt(m[1], 10);
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`;
}

async function selectWorkflow(tx: Db, holdingId: string, requestType?: string) {
  const rows = await tx
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.holdingId, holdingId), eq(schema.workflows.isActive, true)))
    .orderBy(schema.workflows.createdAt);
  return (
    rows.find((w: { requestType: string | null }) => w.requestType === requestType) ??
    rows.find((w: { requestType: string | null }) => w.requestType == null) ??
    rows[0] ??
    null
  );
}

/**
 * Reduce a raw client `customFields` blob to a clean, schema-validated object:
 * keep ONLY enabled non-system fields configured for (holding, screen), coerce
 * each value to its declared type, drop unknown keys, and cap string length.
 * Arrays and non-objects collapse to null. This is the single write-side guard
 * that stops the jsonb column from becoming an open dumping ground.
 */
export async function sanitizeCustomFields(
  db: Db,
  holdingId: string,
  screen: string,
  raw: unknown,
): Promise<Record<string, unknown> | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const rows: {
    fieldKey: string;
    fieldType: string;
    system: boolean;
    enabled: boolean;
    options: unknown;
  }[] = await db
    .select()
    .from(schema.formFields)
    .where(and(eq(schema.formFields.holdingId, holdingId), eq(schema.formFields.screen, screen)));

  const out: Record<string, unknown> = {};
  for (const f of rows) {
    if (f.system || !f.enabled) continue;
    if (!Object.prototype.hasOwnProperty.call(src, f.fieldKey)) continue;
    const v = src[f.fieldKey];
    if (f.fieldType === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.fieldKey] = n;
    } else if (f.fieldType === 'checkbox') {
      out[f.fieldKey] = v === true || v === 'true';
    } else if (f.fieldType === 'select') {
      const opts = Array.isArray(f.options) ? (f.options as { value: string }[]) : [];
      const sv = String(v ?? '');
      if (opts.some((o) => o.value === sv)) out[f.fieldKey] = sv;
    } else if (f.fieldType !== 'file') {
      const s = String(v ?? '').trim().slice(0, 2000);
      if (s) out[f.fieldKey] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

// FIXES 2026-07-20 (тест, дыры валидации): верхние границы против «10¹⁵ штук» —
// дальше bigint-суммы переполняют отчёты, а опечатка в количестве превращается
// в закупку на квадриллион. Границы щедрые для реального производства.
export const MAX_ITEM_QUANTITY = 1_000_000_000; // 10⁹
export const MAX_ITEM_PRICE = 10_000_000_000_000; // 10¹³ UZS за единицу
const MAX_TITLE_LENGTH = 300;

export async function createRequest(db: Db, input: CreateRequestInput) {
  // Items are optional ONLY for fully-custom forms (admin deleted the itemName
  // field). With the standard form, a request without a single named position —
  // or with нулевым количеством — is a validation hole, not a use-case.
  const items = (input.items ?? []).filter((it) => it.name?.trim());
  const materialIds = [...new Set(items.map((it) => it.materialId).filter(Boolean))] as string[];
  if (materialIds.length) {
    const catalogRows = await db
      .select({ id: schema.materials.id })
      .from(schema.materials)
      .where(and(eq(schema.materials.holdingId, input.holdingId), inArray(schema.materials.id, materialIds)));
    if (catalogRows.length !== materialIds.length) throw new ValidationError('Материал не найден в номенклатуре организации');
  }
  for (const it of items) {
    if (!Number.isFinite(it.quantity) || it.quantity <= 0) throw new ValidationError('Количество должно быть больше нуля');
    if (it.quantity > MAX_ITEM_QUANTITY) throw new ValidationError('Количество слишком велико (максимум 1 млрд)');
    assertFiniteNonNeg(it.unitPrice, 'Цена должна быть неотрицательным числом');
    if (it.unitPrice > MAX_ITEM_PRICE) throw new ValidationError('Цена за единицу слишком велика');
    if (it.name!.trim().length > MAX_TITLE_LENGTH) throw new ValidationError('Название позиции слишком длинное (максимум 300 символов)');
  }
  if (items.length === 0) {
    const [itemNameField] = await db
      .select({ id: schema.formFields.id })
      .from(schema.formFields)
      .where(
        and(
          eq(schema.formFields.holdingId, input.holdingId),
          eq(schema.formFields.screen, 'request_create'),
          eq(schema.formFields.fieldKey, 'itemName'),
          eq(schema.formFields.enabled, true),
        ),
      );
    if (itemNameField) throw new ValidationError('Добавьте хотя бы одну позицию');
  }
  if (input.title != null) {
    input.title = String(input.title).trim().slice(0, MAX_TITLE_LENGTH) || undefined;
  }
  const estimatedAmount = Math.round(items.reduce((s, it) => s + it.quantity * it.unitPrice, 0));

  // Duplicate request-number races (MAX+1 has no lock) surface as a 23505 on the unique
  // index — regenerate the number and retry instead of returning a raw 500. (M13)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.transaction(async (tx: Db) => {
    const year = new Date().getFullYear();
    const requestNumber = await generateRequestNumber(tx, input.holdingId, year);
    const workflow = await selectWorkflow(tx, input.holdingId, input.requestType);
    let warehouse: { id: string; name: string } | null = null;
    if (input.warehouseId) {
      [warehouse] = await tx.select({ id: schema.warehouses.id, name: schema.warehouses.name }).from(schema.warehouses)
        .where(and(eq(schema.warehouses.id, input.warehouseId), eq(schema.warehouses.holdingId, input.holdingId), eq(schema.warehouses.status, 'active'))).limit(1);
    } else if (input.warehouseName?.trim()) {
      const wanted = input.warehouseName.trim();
      [warehouse] = await tx.select({ id: schema.warehouses.id, name: schema.warehouses.name }).from(schema.warehouses)
        .where(and(eq(schema.warehouses.holdingId, input.holdingId), eq(schema.warehouses.status, 'active'), or(
          sql`lower(trim(${schema.warehouses.name})) = lower(trim(${wanted}))`,
          sql`lower(trim(coalesce(${schema.warehouses.nameUz}, ''))) = lower(trim(${wanted}))`,
          sql`lower(trim(coalesce(${schema.warehouses.nameTr}, ''))) = lower(trim(${wanted}))`,
        ))).limit(1);
    }
    if ((input.warehouseId || input.warehouseName?.trim()) && !warehouse) throw new ValidationError('Склад не найден в организации');

    // Place the request on the FIRST applicable step of its workflow (data-driven),
    // auto-skipping approval steps whose only approver would be the author (bug #1).
    // With no workflow / no applicable step there is nothing to process — hold it as a
    // DRAFT (fail-safe) rather than silently auto-approving with zero controls. (M12)
    const placement = workflow
      ? await initialPlacement(
          tx,
          workflow.id,
          { amount: estimatedAmount, requestType: input.requestType ?? 'material_request' },
          input.requesterId,
          input.holdingId,
        )
      : { step: null, skipped: [] as any[] };
    const first = placement.step;
    // If every approval step was the author's own and nothing else follows, the chain
    // is effectively approved; otherwise land on `first`, else stay a draft.
    const status = first ? statusForStep(first) : placement.skipped.length ? 'approved' : 'draft';

    const [req] = await tx
      .insert(schema.requests)
      .values({
        requestNumber,
        holdingId: input.holdingId,
        companyId: input.companyId ?? null,
        factoryId: input.factoryId ?? null,
        departmentId: input.departmentId ?? null,
        requesterId: input.requesterId,
        requestType: input.requestType ?? 'material_request',
        priority: input.priority ?? 'normal',
        title: input.title ?? null,
        description: input.description ?? null,
        departmentName: input.departmentName ?? null,
        warehouseId: warehouse?.id ?? null,
        warehouseName: warehouse?.name ?? input.warehouseName ?? null,
        neededDate: input.neededDate ?? null,
        status,
        workflowId: workflow?.id ?? null,
        currentStepId: first?.id ?? null,
        estimatedAmount,
        customFields: input.customFields ?? null,
        source: 'api',
      })
      .returning();

    // An approval-kind first step needs its pending approval row created up-front.
    if (first && first.stepKind === 'approval') {
      await tx.insert(schema.approvals).values({ requestId: req.id, workflowStepId: first.id });
    }

    for (const [index, it] of items.entries()) {
      await tx.insert(schema.requestItems).values({
        requestId: req.id,
        materialId: it.materialId ?? null,
        name: it.name.trim(),
        description: it.description ?? null,
        quantity: String(it.quantity),
        unit: it.unit ?? null,
        estimatedPrice: Math.round(it.unitPrice),
        totalAmount: Math.round(it.quantity * it.unitPrice),
        paymentType: it.paymentType ?? null,
        ndsIncluded: !!it.ndsIncluded,
        sortOrder: index,
      });
    }

    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: null,
      newStatus: status,
      changedBy: input.creatorId ?? input.requesterId,
      source: 'api',
    });
    // Bug #1: record every approval step auto-skipped because the author was the
    // only eligible approver (accountability trail).
    for (const s of placement.skipped) {
      await tx.insert(schema.requestStatusHistory).values({
        requestId: req.id,
        oldStatus: null,
        newStatus: statusForStep(s),
        changedBy: null,
        source: 'auto_skip',
        comment: `Шаг «${s.stepName}» пропущен: единственный согласующий — автор заявки`,
      });
    }
    await tx.insert(schema.auditLogs).values({
      holdingId: input.holdingId,
      factoryId: input.factoryId ?? null,
      userId: input.creatorId ?? input.requesterId,
      action: 'request.created',
      module: 'requests',
      entityType: 'request',
      entityId: req.id,
      newValue: { requestNumber, estimatedAmount },
      source: 'api',
    });

    return req;
      });
    } catch (e: unknown) {
      if (attempt < 4 && (e as { code?: string })?.code === '23505') continue;
      throw e;
    }
  }
  throw new ConflictError('Не удалось создать заявку — повторите попытку');
}
