/**
 * Lifecycle service — data-driven. A request walks the steps configured for its
 * workflow (in the admin constructor): `request.currentStepId` points at the active
 * step, and the action(s) offered there come from the step's KIND (see step-kinds).
 * Routing between steps is computed by the pure engine (applicable steps by
 * amount / inStock / requestType), so the WHOLE path is configuration — not a
 * hardcoded status switch.
 *
 * Each transition runs in one transaction with the full guard stack
 * (valid-action + permission + scope + approver-role + PIN/comment), then writes
 * the new status, a status-history row, approval/signature bookkeeping and a DNA
 * audit log.
 */
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hasPermission, scopeCovers, type Scope } from '../rbac/rbac.js';
import { verifyPin } from '../auth/pin.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from '../http/rate-limit.js';
import { receiveStock, issueStock } from './warehouse.service.js';
import { nextStep, firstStep, type WorkflowContext } from '../workflow/engine.js';
import {
  actionsForKind,
  findKindAction,
  statusForStep,
  STEP_KIND_LABELS,
  TERMINAL_APPROVED,
  TERMINAL_CLOSED,
  TERMINAL_REJECTED,
  type KindStep,
  type StepActionDef,
} from '../workflow/step-kinds.js';

type Db = any;

interface RequestRow {
  id: string;
  holdingId: string;
  companyId: string | null;
  factoryId: string | null;
  departmentId: string | null;
  requesterId: string;
  requestType: string;
  status: string;
  workflowId: string | null;
  currentStepId: string | null;
  estimatedAmount: number;
  inStock: boolean | null;
}

const reqScope = (r: RequestRow): Scope => ({
  holdingId: r.holdingId,
  companyId: r.companyId,
  factoryId: r.factoryId,
  departmentId: r.departmentId,
});

const reqContext = (r: { estimatedAmount: number; inStock: boolean | null; requestType: string }): WorkflowContext => ({
  amount: r.estimatedAmount,
  inStock: r.inStock ?? undefined,
  requestType: r.requestType,
});

const TERMINAL_LABELS: Record<string, string> = {
  [TERMINAL_APPROVED]: 'Согласована',
  [TERMINAL_CLOSED]: 'Закрыта',
  [TERMINAL_REJECTED]: 'Отклонена',
  draft: 'Черновик',
};

/** Load a workflow's steps as engine/kind-aware rows. */
export async function loadKindSteps(db: Db, workflowId: string): Promise<KindStep[]> {
  const rows = await db
    .select()
    .from(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, workflowId));
  return rows.map((s: any) => ({
    id: s.id,
    stepOrder: s.stepOrder,
    stepKind: s.stepKind,
    stepName: s.stepName,
    approverRoleId: s.approverRoleId,
    conditionRule: s.conditionRule,
    thresholdAmount: s.thresholdAmount,
    isRequired: s.isRequired,
    enabled: s.enabled,
  }));
}

/** First applicable step for a fresh request (used at creation), or null. */
export async function firstStepForRequest(
  db: Db,
  workflowId: string,
  ctx: WorkflowContext,
): Promise<KindStep | null> {
  const steps = await loadKindSteps(db, workflowId);
  return firstStep(steps, ctx);
}

async function loadStep(db: Db, stepId: string): Promise<KindStep | null> {
  const [s] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, stepId));
  if (!s) return null;
  return {
    id: s.id,
    stepOrder: s.stepOrder,
    stepKind: s.stepKind,
    stepName: s.stepName,
    approverRoleId: s.approverRoleId,
    conditionRule: s.conditionRule,
    thresholdAmount: s.thresholdAmount,
    isRequired: s.isRequired,
    enabled: s.enabled,
  };
}

async function actorHoldsRoleInScope(db: Db, userId: string, roleId: string, scope: Scope): Promise<boolean> {
  const rows = await db
    .select({
      holdingId: schema.userRoles.holdingId,
      companyId: schema.userRoles.companyId,
      factoryId: schema.userRoles.factoryId,
      departmentId: schema.userRoles.departmentId,
    })
    .from(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.userId, userId),
        eq(schema.userRoles.roleId, roleId),
        eq(schema.userRoles.status, 'active'),
      ),
    );
  return rows.some((r: Scope) => scopeCovers(r, scope));
}

/**
 * Whether `userId` may perform `def` on `step` of `req`. An approval step also
 * requires the actor to hold the step's configured approver role (in scope);
 * reject only needs the reject permission.
 */
async function actorMayAct(
  db: Db,
  userId: string,
  req: RequestRow,
  step: KindStep,
  def: StepActionDef,
): Promise<boolean> {
  const scope = reqScope(req);
  if (!(await hasPermission(db, userId, def.perm, scope))) return false;
  if (step.stepKind === 'approval' && !def.reject && step.approverRoleId) {
    if (!(await actorHoldsRoleInScope(db, userId, step.approverRoleId, scope))) return false;
  }
  return true;
}

export interface UiAction {
  action: string;
  label: string;
  pin: boolean;
  comment: boolean;
  amount: boolean;
  quote: 'add' | 'select' | null;
}

const toUi = (a: StepActionDef): UiAction => ({
  action: a.action,
  label: a.label,
  pin: !!a.pin,
  comment: !!a.comment,
  amount: !!a.amount,
  quote: a.quote ?? null,
});

/**
 * Can the actor perform a PRIMARY (non-reject) action of this step — i.e. are
 * they the person responsible for the current step? Reject is then offered only
 * to that same responsible handler, never to every reject-permission holder.
 */
async function canHandleStep(db: Db, userId: string, req: RequestRow, step: KindStep): Promise<boolean> {
  for (const a of actionsForKind(step.stepKind)) {
    if (a.reject) continue;
    if (a.action === 'approve' && req.requesterId === userId) continue; // separation of duties
    if (await actorMayAct(db, userId, req, step, a)) return true;
  }
  return false;
}

/** Actions the user may take on this request right now (step kind × permission × scope × role). */
export async function availableActions(db: Db, req: RequestRow, userId: string): Promise<UiAction[]> {
  if (!req.currentStepId) return [];
  const step = await loadStep(db, req.currentStepId);
  if (!step) return [];
  const defs = actionsForKind(step.stepKind);
  const out: UiAction[] = [];
  let isHandler = false;
  for (const a of defs) {
    if (a.reject) continue;
    // Self-approval is forbidden by default (separation of duties).
    if (a.action === 'approve' && req.requesterId === userId) continue;
    if (!(await actorMayAct(db, userId, req, step, a))) continue;
    out.push(toUi(a));
    isHandler = true;
  }
  // Reject is shown ONLY to whoever is responsible for the current step.
  if (isHandler) {
    const rej = defs.find((d) => d.reject);
    if (rej && (await hasPermission(db, userId, rej.perm, reqScope(req)))) out.push(toUi(rej));
  }
  return out;
}

/** Human label for the request's current state (step name, or terminal label). */
export async function statusLabelFor(db: Db, req: { status: string; currentStepId: string | null }): Promise<string> {
  if (req.currentStepId) {
    const step = await loadStep(db, req.currentStepId);
    if (step) return step.stepName || STEP_KIND_LABELS[step.stepKind as keyof typeof STEP_KIND_LABELS] || step.stepKind;
  }
  return TERMINAL_LABELS[req.status] ?? req.status;
}

export interface PerformInput {
  requestId: string;
  action: string;
  actor: { id: string; holdingId: string | null };
  pin?: string;
  comment?: string;
  amount?: number;
  supplierName?: string;
  leadTime?: string;
  quotationId?: string;
}

/** Create the pending approval row a step needs when it is an approval step. */
async function enterApprovalIfNeeded(tx: Db, requestId: string, step: KindStep): Promise<void> {
  if (step.stepKind === 'approval') {
    await tx.insert(schema.approvals).values({ requestId, workflowStepId: step.id });
  }
}

export async function performAction(db: Db, input: PerformInput) {
  return db.transaction(async (tx: Db) => {
    const [req] = (await tx.select().from(schema.requests).where(eq(schema.requests.id, input.requestId))) as RequestRow[];
    if (!req || req.holdingId !== input.actor.holdingId) throw new NotFoundError('Заявка не найдена');
    if (!req.currentStepId) throw new ConflictError('Заявка уже завершена');

    const step = await loadStep(tx, req.currentStepId);
    if (!step) throw new ConflictError('Текущий шаг не найден');

    const def = findKindAction(step.stepKind, input.action);
    if (!def) throw new ValidationError('Действие недоступно на этом шаге');

    if (def.action === 'approve' && req.requesterId === input.actor.id) {
      throw new ForbiddenError('Нельзя согласовывать собственную заявку');
    }
    if (!(await actorMayAct(tx, input.actor.id, req, step, def))) {
      throw new ForbiddenError('Недостаточно прав для этого действия');
    }
    // Reject is reserved for the person responsible for the current step.
    if (def.reject && !(await canHandleStep(tx, input.actor.id, req, step))) {
      throw new ForbiddenError('Отклонить может только ответственный за текущий шаг');
    }
    if (def.pin) {
      const lockMs = pinLockoutRemaining(input.actor.id);
      if (lockMs > 0) {
        const mins = Math.ceil(lockMs / 60_000);
        throw new ForbiddenError(`PIN заблокирован — повторите через ${mins} мин.`);
      }
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, input.actor.id));
      if (!u?.pinHash) throw new ForbiddenError('PIN не задан — установите его в профиле');
      if (!verifyPin(String(input.pin ?? ''), u.pinHash)) {
        const locked = recordPinFailure(input.actor.id);
        throw new ForbiddenError(locked ? 'Слишком много попыток — PIN заблокирован на 15 минут' : 'Неверный PIN');
      }
      clearPinFailures(input.actor.id);
    }
    if (def.comment && !String(input.comment ?? '').trim()) {
      throw new ValidationError('Требуется комментарий');
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (def.setInStock !== undefined) patch.inStock = def.setInStock;

    // Procurement: 'add' records a real КП; 'select' picks one and locks the amount.
    if (def.quote === 'add') {
      const amt = Math.max(0, Math.round(Number(input.amount) || 0));
      const supplier = String(input.supplierName ?? '').trim();
      if (!supplier) throw new ValidationError('Укажите поставщика');
      if (!amt) throw new ValidationError('Укажите сумму КП');
      await tx.insert(schema.quotations).values({
        holdingId: req.holdingId,
        requestId: req.id,
        supplierName: supplier,
        amount: amt,
        leadTime: String(input.leadTime ?? '').trim() || null,
        createdBy: input.actor.id,
      });
      patch.estimatedAmount = amt;
    } else if (def.quote === 'select') {
      const [q] = await tx.select().from(schema.quotations).where(eq(schema.quotations.id, String(input.quotationId ?? '')));
      if (!q || q.requestId !== req.id) throw new ValidationError('Выберите КП поставщика');
      await tx.update(schema.quotations).set({ selected: false }).where(eq(schema.quotations.requestId, req.id));
      await tx.update(schema.quotations).set({ selected: true }).where(eq(schema.quotations.id, q.id));
      patch.estimatedAmount = q.amount;
    } else if (def.amount) {
      const n = Number(input.amount);
      if (Number.isFinite(n) && n >= 0) patch.estimatedAmount = Math.round(n);
    }

    // Approval bookkeeping: mark this step's pending approval resolved + sign.
    if (step.stepKind === 'approval') {
      const [pending] = await tx
        .select()
        .from(schema.approvals)
        .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.workflowStepId, step.id), eq(schema.approvals.status, 'pending')));
      const resolveTo = def.reject ? 'rejected' : 'approved';
      if (pending) {
        await tx
          .update(schema.approvals)
          .set({ status: resolveTo, approverUserId: input.actor.id, comment: input.comment ?? null, approvedAt: new Date() })
          .where(eq(schema.approvals.id, pending.id));
        if (!def.reject) {
          await tx.insert(schema.signatures).values({
            approvalId: pending.id,
            requestId: req.id,
            userId: input.actor.id,
            signatureType: 'telegram_pin',
          });
        }
      }
    }

    const from = req.status;
    const ctx = reqContext({
      estimatedAmount: (patch.estimatedAmount as number) ?? req.estimatedAmount,
      inStock: (patch.inStock as boolean) ?? req.inStock,
      requestType: req.requestType,
    });

    let to: string;
    let newCurrentStepId: string | null;

    if (def.reject) {
      to = TERMINAL_REJECTED;
      newCurrentStepId = null;
      patch.closedAt = new Date();
    } else if (!def.advance) {
      // Stays on the same step (e.g. recording another quotation).
      to = from;
      newCurrentStepId = step.id;
    } else {
      const steps = await loadKindSteps(tx, req.workflowId!);
      const next = nextStep(steps, ctx, step.stepOrder) as KindStep | null;
      if (next) {
        to = statusForStep(next);
        newCurrentStepId = next.id;
        await enterApprovalIfNeeded(tx, req.id, next);
      } else {
        to = step.stepKind === 'close' ? TERMINAL_CLOSED : TERMINAL_APPROVED;
        newCurrentStepId = null;
        patch.closedAt = new Date();
      }
    }

    // Warehouse integration: auto-update stock balances on receiving/issue steps.
    // Uses request_items to determine what materials and quantities to process.
    if (!def.reject && def.advance && (step.stepKind === 'receiving' || step.stepKind === 'issue')) {
      const items = await tx.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
      for (const item of items) {
        if (!item.materialId) continue;
        const qty = Number(item.quantity);
        if (!qty || qty <= 0) continue;
        try {
          const op = {
            holdingId: req.holdingId,
            materialId: item.materialId,
            quantity: qty,
            performedBy: input.actor.id,
            requestId: req.id,
            reason: `Lifecycle: ${step.stepKind} — ${req.id.slice(0, 8)}`,
          };
          if (step.stepKind === 'receiving') await receiveStock(tx, op);
          else await issueStock(tx, op);
        } catch {
          // Best-effort: if stock op fails (e.g. insufficient stock), the lifecycle
          // step still completes — the warehouse discrepancy can be resolved manually.
        }
      }
    }

    patch.status = to;
    patch.currentStepId = newCurrentStepId;
    await tx.update(schema.requests).set(patch).where(eq(schema.requests.id, req.id));

    await tx.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      oldStatus: from,
      newStatus: to,
      changedBy: input.actor.id,
      comment: input.comment ?? null,
      source: 'lifecycle',
    });
    await tx.insert(schema.auditLogs).values({
      holdingId: req.holdingId,
      factoryId: req.factoryId,
      userId: input.actor.id,
      action: `request.${def.action}`,
      module: 'lifecycle',
      entityType: 'request',
      entityId: req.id,
      oldValue: { status: from, stepId: step.id },
      newValue: { status: to, stepId: newCurrentStepId },
      source: 'lifecycle',
    });

    const [updated] = await tx.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    return updated;
  });
}
