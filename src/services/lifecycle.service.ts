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
import { and, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hasPermission, scopeCovers, getUserPermissionCodes, type Scope } from '../rbac/rbac.js';
import { verifyPin } from '../auth/pin.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from '../http/rate-limit.js';
import { applyStockOp } from './warehouse.service.js';
import { nextStep, firstStep, applicableSteps, type WorkflowContext } from '../workflow/engine.js';
import {
  actionsForKind,
  findKindAction,
  statusForStep,
  STEP_KIND_LABELS,
  STEP_KINDS,
  STATUS_NEEDS_REVISION,
  TERMINAL_APPROVED,
  TERMINAL_CLOSED,
  TERMINAL_REJECTED,
  TERMINAL_STATUSES,
  type KindStep,
  type OnRejectPolicy,
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
  responsibleUserId: string | null;
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
  [STATUS_NEEDS_REVISION]: 'На доработке',
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
    onReject: s.onReject,
    onRejectStepOrder: s.onRejectStepOrder,
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

/**
 * Bug #1: an approval step is auto-skipped ONLY when the request's author HOLDS that
 * step's role AND is its sole holder in the holding. If the author doesn't hold the
 * role, or someone else also holds it, the step is NOT skipped (preserves normal
 * behaviour, incl. steps whose role currently has no holder). Non-approval steps are
 * never auto-skipped — they are real work.
 */
async function shouldAutoSkipStep(
  db: Db,
  step: KindStep,
  requesterId: string,
  holdingId: string,
): Promise<boolean> {
  if (step.stepKind !== 'approval' || !step.approverRoleId) return false;
  const holders = await db
    .select({ uid: schema.userRoles.userId })
    .from(schema.userRoles)
    .where(
      and(
        eq(schema.userRoles.roleId, step.approverRoleId),
        eq(schema.userRoles.status, 'active'),
        eq(schema.userRoles.holdingId, holdingId),
      ),
    );
  const uids = new Set(holders.map((h: { uid: string }) => h.uid));
  return uids.has(requesterId) && uids.size === 1;
}

/**
 * Walk forward from `start`, skipping approval steps whose only eligible approver is
 * the requester (bug #1). Pure — records nothing; returns the landing step (or null)
 * plus the list of steps that were skipped so the caller can log them.
 */
async function resolveSkippingSelfApprovals(
  db: Db,
  steps: KindStep[],
  ctx: WorkflowContext,
  requesterId: string,
  holdingId: string,
  start: KindStep | null,
): Promise<{ step: KindStep | null; skipped: KindStep[] }> {
  const skipped: KindStep[] = [];
  let cur = start;
  while (cur && (await shouldAutoSkipStep(db, cur, requesterId, holdingId))) {
    skipped.push(cur);
    cur = nextStep(steps, ctx, cur.stepOrder) as KindStep | null;
  }
  return { step: cur, skipped };
}

/** Landing step for a fresh request AFTER auto-skipping the requester's own approval
 *  steps (bug #1), plus the skipped steps for the audit trail. */
export async function initialPlacement(
  db: Db,
  workflowId: string,
  ctx: WorkflowContext,
  requesterId: string,
  holdingId: string,
): Promise<{ step: KindStep | null; skipped: KindStep[] }> {
  const steps = await loadKindSteps(db, workflowId);
  const first = firstStep(steps, ctx) as KindStep | null;
  return resolveSkippingSelfApprovals(db, steps, ctx, requesterId, holdingId, first);
}

export { resolveSkippingSelfApprovals };

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
    onReject: s.onReject,
    onRejectStepOrder: s.onRejectStepOrder,
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
  // Reject/revision гейтятся отдельно через canHandleStep (ответственный за шаг),
  // поэтому требование «держит роль шага» к ним не применяется здесь.
  if (step.stepKind === 'approval' && !def.reject && !def.revision && step.approverRoleId) {
    if (!(await actorHoldsRoleInScope(db, userId, step.approverRoleId, scope))) return false;
  }
  // Bug #8: once a specific procurement person is assigned, only THEY work the
  // procurement step (others with the permission are locked out). Исключение —
  // «Выбрать поставщика»: это решение руководителя снабжения (только у него
  // есть право с 2026-07-06), назначение снабженца его не запирает.
  if (
    step.stepKind === 'procurement' &&
    req.responsibleUserId &&
    req.responsibleUserId !== userId &&
    def.quote !== 'select'
  ) {
    return false;
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
  assign?: boolean;
}

const toUi = (a: StepActionDef, requirePin = true): UiAction => ({
  action: a.action,
  label: a.label,
  pin: !!a.pin && requirePin,
  comment: !!a.comment,
  amount: !!a.amount,
  quote: a.quote ?? null,
  assign: !!a.assign,
});

/**
 * №15: подпись действий настраивается на холдинг — settings key `require_pin`.
 * '0' → вместо PIN обычное подтверждение; отсутствие ключа или любое другое
 * значение → PIN требуется (как раньше).
 */
export async function holdingRequiresPin(db: Db, holdingId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.holdingId, holdingId), eq(schema.settings.key, 'require_pin')));
  return row ? String(row.value) !== '0' : true;
}

/**
 * Can the actor perform a PRIMARY (non-reject) action of this step — i.e. are
 * they the person responsible for the current step? Reject is then offered only
 * to that same responsible handler, never to every reject-permission holder.
 */
/** SoD: the requester may not decide money/routing on their own request. */
const sodBlocked = (def: StepActionDef, req: RequestRow, userId: string): boolean =>
  (def.action === 'approve' || !!def.sod) && req.requesterId === userId;

async function canHandleStep(db: Db, userId: string, req: RequestRow, step: KindStep): Promise<boolean> {
  for (const a of actionsForKind(step.stepKind)) {
    // Гейт строится по ОСНОВНЫМ действиям шага: reject/revision сами защищаются
    // этим предикатом, иначе проверка зациклилась бы на них самих.
    if (a.reject || a.revision) continue;
    if (sodBlocked(a, req, userId)) continue; // separation of duties
    if (a.requesterOnly && req.requesterId !== userId) continue;
    if (await actorMayAct(db, userId, req, step, a)) return true;
  }
  return false;
}

/**
 * Кандидаты инбокса «Ожидают меня» — SQL-префильтр ДО каких-либо лимитов (фикс
 * LIMIT-100: раньше грузились 100 новейших открытых заявок и фильтровались после,
 * поэтому при >100 заявок в работе инбокс согласующего пустел). Отбор по текущему
 * шагу: approval — роль шага среди ролей пользователя; прочие виды — есть право
 * хотя бы одного действия шага; close — только автор; procurement — чужое
 * назначение отсекает; плюс собственные заявки «на доработке» (resubmit).
 * availableActions остаётся финальным судьёй по каждому кандидату — здесь только
 * сужение множества. Используется инбоксом И KPI дашборда, чтобы они совпадали.
 */
export async function inboxCandidates(db: Db, userId: string, holdingId: string): Promise<(RequestRow & { requestNumber: string; title: string | null; createdAt: unknown })[]> {
  const roleRows = await db
    .select({ roleId: schema.userRoles.roleId })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
  const roleIds = roleRows.map((r: { roleId: string }) => r.roleId);
  const permCodes = await getUserPermissionCodes(db, userId);

  const ws = schema.workflowSteps;
  const stepConds: SQL[] = [];
  if (roleIds.length) {
    stepConds.push(and(eq(ws.stepKind, 'approval'), inArray(ws.approverRoleId, roleIds)) as SQL);
  }
  const workableKinds = STEP_KINDS.filter(
    (k) =>
      k !== 'approval' &&
      k !== 'close' &&
      k !== 'procurement' &&
      actionsForKind(k).some((a) => !a.reject && permCodes.includes(a.perm)),
  );
  if (workableKinds.length) stepConds.push(inArray(ws.stepKind, workableKinds) as SQL);
  if (actionsForKind('close').some((a) => !a.reject && permCodes.includes(a.perm))) {
    stepConds.push(and(eq(ws.stepKind, 'close'), eq(schema.requests.requesterId, userId)) as SQL);
  }
  if (permCodes.includes('procurement.select_supplier')) {
    // Руководитель снабжения выбирает поставщика на ЛЮБОЙ закупке — назначение
    // снабженца не убирает шаг из его инбокса (2026-07-06).
    stepConds.push(eq(ws.stepKind, 'procurement') as SQL);
  } else if (actionsForKind('procurement').some((a) => !a.reject && permCodes.includes(a.perm))) {
    stepConds.push(
      and(
        eq(ws.stepKind, 'procurement'),
        or(isNull(schema.requests.responsibleUserId), eq(schema.requests.responsibleUserId, userId)),
      ) as SQL,
    );
  }

  const candidates = stepConds.length
    ? await db
        .select({ r: schema.requests })
        .from(schema.requests)
        .innerJoin(ws, eq(schema.requests.currentStepId, ws.id))
        .where(
          and(
            eq(schema.requests.holdingId, holdingId),
            notInArray(schema.requests.status, [...TERMINAL_STATUSES, 'draft']),
            or(...stepConds),
          ),
        )
        .orderBy(desc(schema.requests.createdAt))
    : [];

  // «На доработке» ждёт самого автора; у таких заявок нет текущего шага.
  const revisions = await db
    .select()
    .from(schema.requests)
    .where(
      and(
        eq(schema.requests.holdingId, holdingId),
        eq(schema.requests.status, STATUS_NEEDS_REVISION),
        eq(schema.requests.requesterId, userId),
      ),
    )
    .orderBy(desc(schema.requests.createdAt));

  const all = [...revisions, ...candidates.map((c: { r: RequestRow }) => c.r)];
  all.sort(
    (a: any, b: any) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
  );
  return all as (RequestRow & { requestNumber: string; title: string | null; createdAt: unknown })[];
}

/** Actions the user may take on this request right now (step kind × permission × scope × role). */
export async function availableActions(db: Db, req: RequestRow, userId: string): Promise<UiAction[]> {
  if (!req.currentStepId) {
    // «На доработке»: автор (и только он) отправляет заявку повторно.
    if (
      req.status === STATUS_NEEDS_REVISION &&
      req.requesterId === userId &&
      (await hasPermission(db, userId, 'requests.create', reqScope(req)))
    ) {
      return [{ action: 'resubmit', label: 'Отправить повторно', pin: false, comment: false, amount: false, quote: null }];
    }
    return [];
  }
  const step = await loadStep(db, req.currentStepId);
  if (!step) return [];
  // Bug #8: the "assign to procurement" action is offered on an approval step only
  // when the NEXT step is a procurement step (i.e. the procurement head hands off).
  let nextIsProcurement = false;
  if (req.workflowId) {
    const steps = await loadKindSteps(db, req.workflowId);
    const ctx = reqContext({ estimatedAmount: req.estimatedAmount, inStock: req.inStock, requestType: req.requestType });
    const nxt = nextStep(steps, ctx, step.stepOrder) as KindStep | null;
    nextIsProcurement = nxt?.stepKind === 'procurement';
  }
  const requirePin = await holdingRequiresPin(db, req.holdingId);
  const defs = actionsForKind(step.stepKind);
  const out: UiAction[] = [];
  let isHandler = false;
  for (const a of defs) {
    if (a.reject || a.revision) continue;
    if (a.assign && !nextIsProcurement) continue; // assign only before a procurement step
    // №16б: перед шагом закупки простое «Согласовать» скрыто — начальник обязан
    // передать заявку конкретному снабженцу (assign_procurement). Если исполнитель
    // УЖЕ назначен ранее (второй проход закупки/доставки), approve остаётся (F1).
    if (a.action === 'approve' && step.stepKind === 'approval' && nextIsProcurement && !req.responsibleUserId) continue;
    // Self-service on money/routing decisions is forbidden (separation of duties).
    if (sodBlocked(a, req, userId)) continue;
    if (a.requesterOnly && req.requesterId !== userId) continue;
    if (!(await actorMayAct(db, userId, req, step, a))) continue;
    out.push(toUi(a, requirePin));
    isHandler = true;
  }
  // Reject/return-for-revision are shown ONLY to whoever handles the current step.
  if (isHandler) {
    const rev = defs.find((d) => d.revision);
    if (rev && (await hasPermission(db, userId, rev.perm, reqScope(req)))) out.push(toUi(rev, requirePin));
    const rej = defs.find((d) => d.reject);
    if (rej && (await hasPermission(db, userId, rej.perm, reqScope(req)))) out.push(toUi(rej, requirePin));
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
  supplierId?: string;
  leadTime?: string;
  quotationId?: string;
  assigneeId?: string;
}

/** Create the pending approval row a step needs when it is an approval step. */
async function enterApprovalIfNeeded(tx: Db, requestId: string, step: KindStep): Promise<void> {
  if (step.stepKind === 'approval') {
    await tx.insert(schema.approvals).values({ requestId, workflowStepId: step.id });
  }
}

export async function performAction(db: Db, input: PerformInput) {
  return db.transaction(async (tx: Db) => {
    // Acquire row-level lock to prevent concurrent modifications
    await tx.execute(sql`SELECT 1 FROM requests WHERE id = ${input.requestId} FOR UPDATE`);
    // Then use Drizzle select (returns camelCase fields)
    const [req] = (await tx.select().from(schema.requests).where(eq(schema.requests.id, input.requestId))) as RequestRow[];
    if (!req || req.holdingId !== input.actor.holdingId) throw new NotFoundError('Заявка не найдена');

    // «На доработке» → повторная отправка автором: маршрут прокладывается заново
    // с первого применимого шага (как при создании), с теми же авто-скипами.
    if (input.action === 'resubmit') {
      if (req.status !== STATUS_NEEDS_REVISION) throw new ConflictError('Заявка не на доработке');
      if (req.requesterId !== input.actor.id) throw new ForbiddenError('Отправить повторно может только автор заявки');
      if (!(await hasPermission(tx, input.actor.id, 'requests.create', reqScope(req)))) {
        throw new ForbiddenError('Недостаточно прав для этого действия');
      }
      if (!req.workflowId) throw new ConflictError('Заявка не привязана к workflow');
      const placement = await initialPlacement(tx, req.workflowId, reqContext(req), req.requesterId, req.holdingId);
      for (const s of placement.skipped) {
        await tx.insert(schema.requestStatusHistory).values({
          requestId: req.id,
          oldStatus: req.status,
          newStatus: statusForStep(s),
          changedBy: null,
          source: 'auto_skip',
          comment: `Шаг «${s.stepName}» пропущен: единственный согласующий — автор заявки`,
        });
      }
      const landed = placement.step;
      const rePatch: Record<string, unknown> = { updatedAt: new Date() };
      let reTo: string;
      if (landed) {
        reTo = statusForStep(landed);
        rePatch.currentStepId = landed.id;
        await enterApprovalIfNeeded(tx, req.id, landed);
      } else {
        reTo = TERMINAL_APPROVED;
        rePatch.currentStepId = null;
        rePatch.closedAt = new Date();
      }
      rePatch.status = reTo;
      await tx.update(schema.requests).set(rePatch).where(eq(schema.requests.id, req.id));
      await tx.insert(schema.requestStatusHistory).values({
        requestId: req.id,
        oldStatus: req.status,
        newStatus: reTo,
        changedBy: input.actor.id,
        comment: input.comment ?? null,
        source: 'lifecycle',
      });
      await tx.insert(schema.auditLogs).values({
        holdingId: req.holdingId,
        factoryId: req.factoryId,
        userId: input.actor.id,
        action: 'request.resubmit',
        module: 'lifecycle',
        entityType: 'request',
        entityId: req.id,
        oldValue: { status: req.status, stepId: null },
        newValue: { status: reTo, stepId: (rePatch.currentStepId as string | null) ?? null },
        source: 'lifecycle',
      });
      const [resubmitted] = await tx.select().from(schema.requests).where(eq(schema.requests.id, req.id));
      return { ...resubmitted, warnings: [] };
    }

    if (!req.currentStepId) {
      // Distinguish a never-started draft (no workflow matched at creation) from a
      // finished request — the old message misled users about drafts. (B10)
      throw new ConflictError(
        req.status === 'draft'
          ? 'Заявка в черновике: не привязана к workflow — настройте активный workflow и создайте заявку заново'
          : 'Заявка уже завершена',
      );
    }

    const step = await loadStep(tx, req.currentStepId);
    if (!step) throw new ConflictError('Текущий шаг не найден');

    const def = findKindAction(step.stepKind, input.action);
    if (!def) throw new ValidationError('Действие недоступно на этом шаге');

    if (sodBlocked(def, req, input.actor.id)) {
      throw new ForbiddenError(
        def.action === 'approve'
          ? 'Нельзя согласовывать собственную заявку'
          : 'Нельзя выполнять это действие по собственной заявке (разделение обязанностей)',
      );
    }
    if (def.requesterOnly && req.requesterId !== input.actor.id) {
      throw new ForbiddenError('Подтвердить получение может только автор заявки');
    }
    if (!(await actorMayAct(tx, input.actor.id, req, step, def))) {
      throw new ForbiddenError('Недостаточно прав для этого действия');
    }
    // Reject / return-for-revision are reserved for the current step's handler.
    if ((def.reject || def.revision) && !(await canHandleStep(tx, input.actor.id, req, step))) {
      throw new ForbiddenError(
        def.revision ? 'Вернуть на доработку может только ответственный за текущий шаг' : 'Отклонить может только ответственный за текущий шаг',
      );
    }
    // №16б: серверное зеркало правила «перед закупкой — только передача снабженцу»:
    // approve на approval-шаге, за которым идёт procurement, отклоняется и через API,
    // но ТОЛЬКО пока исполнитель ещё не назначен (второй проход закупки — F1).
    if (def.action === 'approve' && step.stepKind === 'approval' && req.workflowId && !req.responsibleUserId) {
      const steps = await loadKindSteps(tx, req.workflowId);
      const ctx0 = reqContext(req);
      const nxt = nextStep(steps, ctx0, step.stepOrder) as KindStep | null;
      if (nxt?.stepKind === 'procurement') {
        throw new ConflictError('Перед закупкой заявку передают конкретному снабженцу — используйте «Передать снабженцу»');
      }
    }
    if (def.pin && (await holdingRequiresPin(tx, req.holdingId))) {
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
    const warnings: string[] = [];
    if (def.quote === 'add') {
      const amt = Math.max(0, Math.round(Number(input.amount) || 0));
      if (!amt) throw new ValidationError('Укажите сумму КП');
      let supplierName = String(input.supplierName ?? '').trim();
      let supplierId: string | null = null;
      // Preferred: a normalized supplier (validated within the holding). Legacy
      // free-text supplierName is kept as a snapshot / fallback.
      if (input.supplierId) {
        const [sup] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId));
        if (!sup || sup.holdingId !== req.holdingId) throw new ValidationError('Поставщик не найден');
        supplierId = sup.id;
        if (!supplierName) supplierName = sup.name;
      }
      if (!supplierName) throw new ValidationError('Укажите поставщика');
      const [quote] = await tx
        .insert(schema.quotations)
        .values({
          holdingId: req.holdingId,
          requestId: req.id,
          supplierId,
          supplierName,
          amount: amt,
          leadTime: String(input.leadTime ?? '').trim() || null,
          createdBy: input.actor.id,
        })
        .returning();
      await tx.insert(schema.auditLogs).values({
        holdingId: req.holdingId,
        factoryId: req.factoryId,
        userId: input.actor.id,
        action: 'quotation.created',
        module: 'procurement',
        entityType: 'quotation',
        entityId: quote.id,
        newValue: { supplierId, supplierName, amount: amt },
        source: 'lifecycle',
      });
      // The request amount is locked only when a supplier is SELECTED — merely
      // recording another КП must not swing estimatedAmount around. (L4)
    } else if (def.quote === 'select') {
      const [q] = await tx.select().from(schema.quotations).where(eq(schema.quotations.id, String(input.quotationId ?? '')));
      if (!q || q.requestId !== req.id) throw new ValidationError('Выберите КП поставщика');
      const all = await tx.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
      // Single-quotation warning: don't block (a sole supplier is sometimes valid).
      if (all.length === 1) warnings.push('Только одно КП по заявке — сравнение цен невозможно');
      await tx.update(schema.quotations).set({ selected: false }).where(eq(schema.quotations.requestId, req.id));
      await tx.update(schema.quotations).set({ selected: true }).where(eq(schema.quotations.id, q.id));
      await tx.insert(schema.auditLogs).values({
        holdingId: req.holdingId,
        factoryId: req.factoryId,
        userId: input.actor.id,
        action: 'supplier.selected',
        module: 'procurement',
        entityType: 'quotation',
        entityId: q.id,
        newValue: { supplierId: q.supplierId ?? null, supplierName: q.supplierName, amount: q.amount, singleQuotation: all.length === 1 },
        source: 'lifecycle',
      });
      patch.estimatedAmount = q.amount;
    } else if (def.amount) {
      const n = Number(input.amount);
      if (Number.isFinite(n) && n >= 0) patch.estimatedAmount = Math.round(n);
    }

    // Bug #8: assign a specific procurement person — only they will work the
    // upcoming procurement step. Validate the assignee is an active procurement user.
    if (def.assign) {
      const assigneeId = String(input.assigneeId ?? '');
      if (!assigneeId) throw new ValidationError('Выберите снабженца');
      const [assignee] = await tx
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, assigneeId), eq(schema.users.holdingId, req.holdingId), eq(schema.users.status, 'active')));
      if (!assignee) throw new ValidationError('Снабженец не найден в организации');
      const acodes = await getUserPermissionCodes(tx, assigneeId);
      if (!['procurement.quote', 'procurement.select_supplier', 'procurement.view'].some((p) => acodes.includes(p))) {
        throw new ValidationError('У выбранного пользователя нет прав снабжения');
      }
      patch.responsibleUserId = assigneeId;
      await tx.insert(schema.auditLogs).values({
        holdingId: req.holdingId,
        factoryId: req.factoryId,
        userId: input.actor.id,
        action: 'procurement.assigned',
        module: 'procurement',
        entityType: 'request',
        entityId: req.id,
        newValue: { assigneeId, assigneeName: assignee.fullName },
        source: 'lifecycle',
      });
    }

    // Approval bookkeeping: mark this step's pending approval resolved + sign.
    if (step.stepKind === 'approval') {
      const [pending] = await tx
        .select()
        .from(schema.approvals)
        .where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.workflowStepId, step.id), eq(schema.approvals.status, 'pending')));
      // №11: возврат на доработку не решает согласование — pending снимается как
      // 'cancelled' (без подписи) и будет создан заново при resubmit.
      const resolveTo = def.reject ? 'rejected' : def.revision ? 'cancelled' : 'approved';
      if (pending) {
        await tx
          .update(schema.approvals)
          .set({ status: resolveTo, approverUserId: input.actor.id, comment: input.comment ?? null, approvedAt: new Date() })
          .where(eq(schema.approvals.id, pending.id));
        if (!def.reject && !def.revision) {
          await tx.insert(schema.signatures).values({
            approvalId: pending.id,
            requestId: req.id,
            userId: input.actor.id,
            signatureType: 'telegram_pin',
          });
        }
      } else if (!def.reject && !def.revision) {
        // No pending row (workflow edited after creation, legacy data): an approval
        // must still leave a resolved record + signature in the DNA — never a silent
        // "approved without a trace". (L2)
        const [made] = await tx
          .insert(schema.approvals)
          .values({
            requestId: req.id,
            workflowStepId: step.id,
            status: resolveTo,
            approverUserId: input.actor.id,
            comment: input.comment ?? null,
            approvedAt: new Date(),
          })
          .returning();
        await tx.insert(schema.signatures).values({
          approvalId: made.id,
          requestId: req.id,
          userId: input.actor.id,
          signatureType: 'telegram_pin',
        });
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

    if (def.revision) {
      // №11: назад к автору на доработку — независимо от политики on_reject шага.
      to = STATUS_NEEDS_REVISION;
      newCurrentStepId = null;
    } else if (def.reject) {
      // Ветка «Если отклонил» шага: отменить / вернуть автору / вернуть на шаг N.
      const policy = (step.onReject ?? 'cancel') as OnRejectPolicy;
      if (policy === 'return_requester') {
        to = STATUS_NEEDS_REVISION;
        newCurrentStepId = null;
      } else if (policy === 'return_step' && req.workflowId && step.onRejectStepOrder != null) {
        // Возврат допустим только на БОЛЕЕ РАННИЙ применимый шаг — вперёд и на
        // самого себя нельзя (петля). Некорректная настройка → как cancel.
        const steps = await loadKindSteps(tx, req.workflowId);
        const target = (applicableSteps(steps, ctx) as KindStep[]).find(
          (s) => s.stepOrder === step.onRejectStepOrder && s.stepOrder < step.stepOrder,
        );
        if (target) {
          to = statusForStep(target);
          newCurrentStepId = target.id;
          await enterApprovalIfNeeded(tx, req.id, target);
        } else {
          to = TERMINAL_REJECTED;
          newCurrentStepId = null;
          patch.closedAt = new Date();
        }
      } else {
        to = TERMINAL_REJECTED;
        newCurrentStepId = null;
        patch.closedAt = new Date();
      }
    } else if (!def.advance) {
      // Stays on the same step (e.g. recording another quotation).
      to = from;
      newCurrentStepId = step.id;
    } else {
      const steps = await loadKindSteps(tx, req.workflowId!);
      let next = nextStep(steps, ctx, step.stepOrder) as KindStep | null;
      // Bug #1: auto-skip the next approval step(s) if the author is their only approver.
      const selfSkip = await resolveSkippingSelfApprovals(tx, steps, ctx, req.requesterId, req.holdingId, next);
      next = selfSkip.step;
      for (const s of selfSkip.skipped) {
        await tx.insert(schema.requestStatusHistory).values({
          requestId: req.id,
          oldStatus: from,
          newStatus: statusForStep(s),
          changedBy: null,
          source: 'auto_skip',
          comment: `Шаг «${s.stepName}» пропущен: единственный согласующий — автор заявки`,
        });
      }
      if (next) {
        to = statusForStep(next);
        newCurrentStepId = next.id;
        await enterApprovalIfNeeded(tx, req.id, next);
      } else {
        // A chain that ends after physical fulfilment (issue/close) is CLOSED;
        // ending anywhere earlier means "approved but not fulfilled". (L3)
        to = step.stepKind === 'close' || step.stepKind === 'issue' ? TERMINAL_CLOSED : TERMINAL_APPROVED;
        newCurrentStepId = null;
        patch.closedAt = new Date();
      }
    }

    // Warehouse integration: stock moves through the warehouse service (the single
    // authoritative path) on receiving/issue steps, using request_items for the
    // materials and quantities. Fail-loud: if a stock op fails (e.g. insufficient
    // stock) it throws, this whole transaction rolls back, and the step does NOT
    // advance — never a silent completion with drifted balances. Idempotency in the
    // service keeps a given (request, material, type) from being applied twice.
    if (!def.reject && def.advance && (step.stepKind === 'receiving' || step.stepKind === 'issue')) {
      const items = await tx.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
      // Aggregate quantities by materialId so duplicate rows don't cause
      // multiple independent stock ops for the same material.
      const byMaterial = new Map<string, number>();
      const skipped: string[] = [];
      for (const item of items) {
        const qty = Number(item.quantity);
        if (!item.materialId || !qty || qty <= 0) {
          skipped.push(item.name);
          continue;
        }
        byMaterial.set(item.materialId, (byMaterial.get(item.materialId) ?? 0) + qty);
      }
      // Free-text items can't move stock — say so instead of finishing silently. (M3)
      if (skipped.length) {
        warnings.push(`Позиции без привязки к материалу склад не двигали: ${skipped.join(', ')}`);
      }
      for (const [materialId, quantity] of byMaterial) {
        const op = {
          holdingId: req.holdingId,
          materialId,
          quantity,
          performedBy: input.actor.id,
          requestId: req.id,
          workflowStepId: step.id,
          reason: `Lifecycle: ${step.stepKind} — ${req.id.slice(0, 8)}`,
          source: 'lifecycle',
        };
        if (step.stepKind === 'receiving') await applyStockOp(tx, op, 'income');
        else await applyStockOp(tx, op, 'outcome');
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
    return { ...updated, warnings };
  });
}
