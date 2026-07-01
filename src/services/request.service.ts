/**
 * Request service — creating a request atomically: number, items, the first
 * approval, status history and audit, all in one transaction. The request number
 * is year-scoped and NaN-safe (fixing the legacy generator), and the workflow +
 * first step are chosen by the data-driven engine, not hardcoded.
 */
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { firstStepForRequest } from './lifecycle.service.js';
import { statusForStep } from '../workflow/step-kinds.js';
import { ValidationError, ConflictError } from './errors.js';

type Db = any;

export interface CreateRequestItem {
  name: string;
  materialId?: string | null;
  quantity: number;
  unitPrice: number;
  unit?: string | null;
}

export interface CreateRequestInput {
  holdingId: string;
  requesterId: string;
  companyId?: string | null;
  factoryId?: string | null;
  departmentId?: string | null;
  requestType?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
  title?: string;
  description?: string;
  departmentName?: string | null;
  warehouseName?: string | null;
  neededDate?: Date | null;
  customFields?: Record<string, unknown> | null;
  items: CreateRequestItem[];
}

function assertFiniteNonNeg(n: number, message: string): void {
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(message);
}

async function generateRequestNumber(tx: Db, holdingId: string, year: number): Promise<string> {
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

export async function createRequest(db: Db, input: CreateRequestInput) {
  // Items are optional: an admin can delete the name/quantity fields and build a
  // fully-custom form. Keep only items that actually carry a name; drop blanks.
  const items = (input.items ?? []).filter((it) => it.name?.trim());
  for (const it of items) {
    assertFiniteNonNeg(it.quantity, 'Количество должно быть неотрицательным числом');
    assertFiniteNonNeg(it.unitPrice, 'Цена должна быть неотрицательным числом');
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

    // Place the request on the FIRST applicable step of its workflow (data-driven).
    // With no workflow / no applicable step there is nothing to process — hold it as a
    // DRAFT (fail-safe) rather than silently auto-approving with zero controls. (M12)
    const first = workflow
      ? await firstStepForRequest(tx, workflow.id, {
          amount: estimatedAmount,
          requestType: input.requestType ?? 'material_request',
        })
      : null;
    const status = first ? statusForStep(first) : 'draft';

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
        warehouseName: input.warehouseName ?? null,
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

    for (const it of items) {
      await tx.insert(schema.requestItems).values({
        requestId: req.id,
        materialId: it.materialId ?? null,
        name: it.name.trim(),
        quantity: String(it.quantity),
        unit: it.unit ?? null,
        estimatedPrice: Math.round(it.unitPrice),
        totalAmount: Math.round(it.quantity * it.unitPrice),
      });
    }

    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: null,
      newStatus: status,
      changedBy: input.requesterId,
      source: 'api',
    });
    await tx.insert(schema.auditLogs).values({
      holdingId: input.holdingId,
      factoryId: input.factoryId ?? null,
      userId: input.requesterId,
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
