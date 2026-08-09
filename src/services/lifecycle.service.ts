/**
 * Lifecycle service — data-driven. A request walks the steps configured for its
 * workflow (in the admin constructor): `request.currentStepId` points at the active
 * step, and the action(s) offered there come from the step's KIND (see step-kinds).
 * Routing between steps is computed by the pure engine (applicable steps by
 * amount / inStock / requestType), so the WHOLE path is configuration — not a
 * hardcoded status switch.
 *
 * Each transition runs in one transaction with the full guard stack
 * (valid-action + permission + scope + approver-role + comment), then writes
 * the new status, a status-history row, approval/signature bookkeeping and a DNA
 * audit log.
 */
import { and, eq, inArray, isNull, like, notInArray, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hasPermission, getUserPermissionCodes, type Scope } from '../rbac/rbac.js';
import { roleActorIdsForScope } from './step-actors.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from './errors.js';
import { applyStockOp } from './warehouse.service.js';
import { normalizePhone } from '../auth/phone.js';
import { nextStep, firstStep, applicableSteps, type WorkflowContext } from '../workflow/engine.js';
import {
  actionsForKind,
  findKindAction,
  statusForStep,
  STEP_KIND_LABELS,
  STEP_KINDS,
  STATUS_NEEDS_REVISION,
  TERMINAL_APPROVED,
  TERMINAL_ARCHIVED,
  TERMINAL_CANCELLED,
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
  requestNumber: string;
  title: string | null;
  holdingId: string;
  companyId: string | null;
  factoryId: string | null;
  departmentId: string | null;
  requesterId: string;
  responsibleUserId: string | null;
  warehouseId: string | null;
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
  [TERMINAL_CANCELLED]: 'Отменена',
  [TERMINAL_ARCHIVED]: 'В архиве',
  // FIXES 2026-07-17 (лист E): явный статус возврата.
  [STATUS_NEEDS_REVISION]: 'Возвращено на доработку',
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
 * A request may skip its own approval only when it was created personally by the
 * requester. In particular, a department head's own department-head approval is
 * redundant even when the holding has other department heads. Requests filled in by
 * an assistant on somebody else's behalf must never inherit this self-skip.
 */
async function shouldAutoSkipStep(
  db: Db,
  step: KindStep,
  requesterId: string,
  holdingId: string,
  creatorId: string,
  scope: Scope,
): Promise<boolean> {
  if (step.stepKind !== 'approval' || !step.approverRoleId) return false;
  if (creatorId !== requesterId) return false;

  const [role] = await db
    .select({ code: schema.roles.code })
    .from(schema.roles)
    .where(eq(schema.roles.id, step.approverRoleId))
    .limit(1);
  if (role?.code === 'dept_head') {
    return (await roleActorIdsForScope(db, step.approverRoleId, scope, requesterId)).includes(requesterId);
  }

  // Preserve the historical rule for other approval roles: only a sole holder can
  // self-skip the step.
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
  creatorId = requesterId,
  scope: Scope = { holdingId },
): Promise<{ step: KindStep | null; skipped: KindStep[] }> {
  const skipped: KindStep[] = [];
  let cur = start;
  while (cur && (await shouldAutoSkipStep(db, cur, requesterId, holdingId, creatorId, scope))) {
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
  creatorId = requesterId,
  scope: Scope = { holdingId },
): Promise<{ step: KindStep | null; skipped: KindStep[] }> {
  const steps = await loadKindSteps(db, workflowId);
  const first = firstStep(steps, ctx) as KindStep | null;
  return resolveSkippingSelfApprovals(db, steps, ctx, requesterId, holdingId, first, creatorId, scope);
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
  return (await roleActorIdsForScope(db, roleId, scope, userId)).includes(userId);
}

async function originalCreatorId(db: Db, requestId: string, fallbackId: string): Promise<string> {
  const rows = await db
    .select({ changedBy: schema.requestStatusHistory.changedBy })
    .from(schema.requestStatusHistory)
    .where(and(eq(schema.requestStatusHistory.requestId, requestId), isNull(schema.requestStatusHistory.oldStatus)))
    .orderBy(schema.requestStatusHistory.createdAt);
  return rows.find((row: { changedBy: string | null }) => row.changedBy)?.changedBy ?? fallbackId;
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
  if (['approval', 'price_approval'].includes(step.stepKind) && !def.reject && !def.revision && step.approverRoleId) {
    if (!(await actorHoldsRoleInScope(db, userId, step.approverRoleId, scope))) return false;
  }
  // Once a specific procurement person is assigned, only they work the
  // procurement-family operational steps. The head assigns, then the assignee
  // moves the request through supplier/payment/delivery statuses.
  if (
    ['procurement', 'ordering', 'delivery'].includes(step.stepKind) &&
    req.responsibleUserId &&
    req.responsibleUserId !== userId &&
    ['procurement.quote', 'procurement.view'].includes(def.perm)
  ) {
    return false;
  }
  if (['warehouse_check', 'receiving', 'issue'].includes(step.stepKind) && req.warehouseId) {
    const [assigned] = await db.select({ userId: schema.warehouseResponsibles.userId })
      .from(schema.warehouseResponsibles)
      .where(and(eq(schema.warehouseResponsibles.warehouseId, req.warehouseId), eq(schema.warehouseResponsibles.holdingId, req.holdingId)))
      .limit(1);
    if (assigned && assigned.userId !== userId) return false;
  }
  return true;
}

/** Есть ли по заявке выбранное (selected) КП — т.е. поставщик уже определён. */
async function hasSelectedQuote(db: Db, requestId: string): Promise<boolean> {
  const [q] = await db
    .select({ id: schema.quotations.id })
    .from(schema.quotations)
    .where(and(eq(schema.quotations.requestId, requestId), eq(schema.quotations.selected, true)))
    .limit(1);
  return !!q;
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

const toUi = (a: StepActionDef): UiAction => ({
  action: a.action,
  label: a.label,
  pin: false,
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
    // New procurement flow: one proposal is saved, auto-selected, then the
    // request moves to the manager approval step. Keep legacy actions callable
    // server-side, but don't surface them in the app.
    if (step.stepKind === 'procurement' && a.action !== 'add_quotation') continue;
    // FIXES 2026-07-17 (лист G): на проверке цены есть и «Пересмотреть цену».
    if (step.stepKind === 'price_approval' && !['approve_price', 'return_research'].includes(a.action)) continue;
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
  if (actionsForKind('procurement').some((a) => !a.reject && permCodes.includes(a.perm))) {
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
        // FIXES 2026-07-17 (лист C): заявки везде идут от первой созданной вниз.
        .orderBy(schema.requests.createdAt)
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
    .orderBy(schema.requests.createdAt);

  const all = [...revisions, ...candidates.map((c: { r: RequestRow }) => c.r)];
  // FIXES 2026-07-17 (лист C): порядок — от первой созданной к последней.
  all.sort(
    (a: any, b: any) => new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime(),
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
  let nextIsDirectProcurement = false;
  if (req.workflowId) {
    const steps = await loadKindSteps(db, req.workflowId);
    const ctx = reqContext({ estimatedAmount: req.estimatedAmount, inStock: req.inStock, requestType: req.requestType });
    const nxt = nextStep(steps, ctx, step.stepOrder) as KindStep | null;
    nextIsDirectProcurement = nxt?.stepKind === 'procurement';
    // Assign-handoff is offered before either procurement-family entry step.
    nextIsProcurement = nextIsDirectProcurement || nxt?.stepKind === 'procurement_intake';
  }
  const defs = actionsForKind(step.stepKind);
  // Повторный проход закупки: поставщик уже выбран → снабженцу предлагается
  // «Закуплено» (продвигает шаг); до выбора поставщика действия нет.
  const supplierChosen =
    step.stepKind === 'procurement' && defs.some((d) => d.needsSelectedQuote)
      ? await hasSelectedQuote(db, req.id)
      : false;
  const out: UiAction[] = [];
  let isHandler = false;
  for (const a of defs) {
    if (a.reject || a.revision) continue;
    if (step.stepKind === 'procurement' && a.action !== 'add_quotation') continue;
    // FIXES 2026-07-17 (лист G): на проверке цены доступно и «Пересмотреть цену»
    // (возврат снабженцу на шаг поиска с причиной). FIXES 2026-07-20: плюс
    // «Выбрать поставщика» — руководитель снабжения выбирает КП из собранных.
    if (step.stepKind === 'price_approval' && !['approve_price', 'return_research', 'select_supplier'].includes(a.action)) continue;
    // Assign-handoff on an APPROVAL step only before procurement; on procurement_intake
    // «Назначить снабженца» is a first-class action always available.
    if (a.assign && step.stepKind === 'approval' && !nextIsProcurement) continue;
    // «Вернуть на пересмотр/поиск» — только когда у шага настроен шаг возврата.
    if (a.returnStep && step.onRejectStepOrder == null) continue;
    if (a.needsSelectedQuote && !supplierChosen) continue; // «Закуплено»/«Передать» — только когда поставщик выбран
    // №16б: перед ПРЯМЫМ шагом закупки простое «Согласовать» скрыто — начальник обязан
    // передать заявку конкретному снабженцу. С шагом «Принятие заявки» (procurement_intake)
    // назначение делается там, поэтому approve на согласовании остаётся.
    if (a.action === 'approve' && step.stepKind === 'approval' && nextIsDirectProcurement && !req.responsibleUserId) continue;
    // Self-service on money/routing decisions is forbidden (separation of duties).
    if (sodBlocked(a, req, userId)) continue;
    if (a.requesterOnly && req.requesterId !== userId) continue;
    if (!(await actorMayAct(db, userId, req, step, a))) continue;
    out.push(toUi(a));
    isHandler = true;
  }
  // Reject/return-for-revision are shown ONLY to whoever handles the current step.
  // FIXES 2026-07-20 (тест): price_approval больше не исключается — «Отклонить
  // закупку» (reject_purchase, perm procurement.select_supplier) снова доступна
  // руководителю снабжения; у менеджера права нет, у шага нет revision-действия.
  if (isHandler && step.stepKind !== 'procurement') {
    const rev = defs.find((d) => d.revision);
    if (rev && (await hasPermission(db, userId, rev.perm, reqScope(req)))) out.push(toUi(rev));
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
  supplierId?: string;
  supplierPhone?: string;
  ndsIncluded?: boolean;
  paymentType?: string;
  quoteItems?: { itemId: string; unitPrice: number; supplierName?: string; supplierId?: string | null; ndsIncluded?: boolean; paymentType?: string | null }[];
  leadTime?: string;
  quotationId?: string;
  assigneeId?: string;
  /** #11 приёмка по позициям: фактически принятое количество на позицию. */
  receipts?: { itemId: string; receivedQty: number }[];
}

/** Create the pending approval row a step needs when it is an approval step. */
async function enterApprovalIfNeeded(tx: Db, requestId: string, step: KindStep): Promise<void> {
  if (step.stepKind === 'approval') {
    await tx.insert(schema.approvals).values({ requestId, workflowStepId: step.id });
  }
}

/** Next REQ-<year>-NNNNN for a holding (inlined to avoid a request.service cycle). */
async function nextRequestNumber(tx: Db, holdingId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `REQ-${year}-`;
  const rows: { rn: string }[] = await tx
    .select({ rn: schema.requests.requestNumber })
    .from(schema.requests)
    .where(and(eq(schema.requests.holdingId, holdingId), like(schema.requests.requestNumber, `${prefix}%`)));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.rn);
    if (m) { const seq = parseInt(m[1], 10); if (Number.isFinite(seq) && seq > max) max = seq; }
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`;
}

/**
 * #3 Частичное наличие: делит заявку по статусу позиций.
 * - все in-stock → { parentInStock:true } (без дробления, как «Есть в наличии»);
 * - все out-of-stock → { parentInStock:false } (вся заявка идёт в закупку);
 * - смешанно → out-of-stock позиции переносятся в НОВУЮ связанную заявку
 *   (parent_request_id), которая встаёт на закупочный шаг; исходная остаётся с
 *   in-stock позициями и как in-stock идёт на выдачу.
 */
async function applyPartialStockSplit(
  tx: Db,
  req: RequestRow,
  step: KindStep,
  actorId: string,
): Promise<{ parentInStock: boolean; childId: string | null; childNumber: string | null }> {
  const items = await tx.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
  const outItems = items.filter((i: any) => i.status === 'out_of_stock');
  const inItems = items.filter((i: any) => i.status !== 'out_of_stock');
  for (const it of inItems) {
    if ((it as any).status !== 'in_stock') {
      await tx.update(schema.requestItems).set({ status: 'in_stock' }).where(eq(schema.requestItems.id, (it as any).id));
    }
  }
  if (outItems.length === 0) return { parentInStock: true, childId: null, childNumber: null };
  if (inItems.length === 0) return { parentInStock: false, childId: null, childNumber: null };

  // Where a fully out-of-stock order would go right after warehouse_check.
  const steps = await loadKindSteps(tx, req.workflowId!);
  const childCtx = reqContext({ estimatedAmount: req.estimatedAmount, inStock: false, requestType: req.requestType });
  const childStep = nextStep(steps, childCtx, step.stepOrder) as KindStep | null;

  const number = await nextRequestNumber(tx, req.holdingId);
  const childEstimated = outItems.reduce((s: number, i: any) => s + Number(i.totalAmount || 0), 0);
  const [child] = await tx
    .insert(schema.requests)
    .values({
      requestNumber: number,
      holdingId: req.holdingId,
      companyId: (req as any).companyId ?? null,
      factoryId: req.factoryId ?? null,
      departmentId: (req as any).departmentId ?? null,
      requesterId: req.requesterId,
      requestType: req.requestType,
      title: req.title ? `${req.title} — докупка` : 'Докупка (нехватка на складе)',
      description: (req as any).description ?? null,
      priority: (req as any).priority ?? 'normal',
      departmentName: (req as any).departmentName ?? null,
      warehouseName: (req as any).warehouseName ?? null,
      status: childStep ? statusForStep(childStep) : TERMINAL_APPROVED,
      workflowId: req.workflowId,
      currentStepId: childStep?.id ?? null,
      inStock: false,
      estimatedAmount: childEstimated,
      currency: (req as any).currency ?? 'UZS',
      neededDate: (req as any).neededDate ?? null,
      source: 'split',
      parentRequestId: req.id,
      customFields: (req as any).customFields ?? null,
      closedAt: childStep ? null : new Date(),
    })
    .returning();
  if (childStep) await enterApprovalIfNeeded(tx, child.id, childStep);
  for (const it of outItems) {
    await tx
      .update(schema.requestItems)
      .set({ requestId: child.id, status: 'out_of_stock', receivedQty: '0' })
      .where(eq(schema.requestItems.id, (it as any).id));
  }
  await tx.update(schema.requests).set({ estimatedAmount: inItems.reduce((s: number, i: any) => s + Number(i.totalAmount || 0), 0) }).where(eq(schema.requests.id, req.id));
  await tx.insert(schema.requestStatusHistory).values({
    requestId: child.id,
    oldStatus: null,
    newStatus: child.status,
    changedBy: actorId,
    source: 'split',
    comment: `Выделено из заявки ${req.requestNumber}: недостающие позиции`,
  });
  await tx.insert(schema.auditLogs).values({
    holdingId: req.holdingId,
    factoryId: req.factoryId ?? null,
    userId: actorId,
    action: 'request.split',
    module: 'lifecycle',
    entityType: 'request',
    entityId: child.id,
    newValue: { parentRequestId: req.id, requestNumber: number, items: outItems.length },
    source: 'lifecycle',
  });
  return { parentInStock: true, childId: child.id, childNumber: number };
}

/**
 * #3 Кнопки «В наличии / Нет» у каждой позиции на шаге склада. Отмечает наличие
 * одной позиции (request_items.status); дробление затем делает действие wh_partial.
 */
export async function markItemStock(
  db: Db,
  input: { requestId: string; itemId: string; inStock: boolean; actor: { id: string; holdingId: string | null } },
) {
  return db.transaction(async (tx: Db) => {
    const [req] = (await tx.select().from(schema.requests).where(eq(schema.requests.id, input.requestId))) as RequestRow[];
    if (!req || req.holdingId !== input.actor.holdingId) throw new NotFoundError('Заявка не найдена');
    if (!req.currentStepId) throw new ConflictError('Заявка не на активном шаге');
    const step = await loadStep(tx, req.currentStepId);
    if (!step || step.stepKind !== 'warehouse_check') throw new ConflictError('Отметить наличие можно только на шаге проверки склада');
    if (req.requesterId === input.actor.id) throw new ForbiddenError('Нельзя проверять наличие по собственной заявке');
    if (!(await hasPermission(tx, input.actor.id, 'warehouse.check_stock', reqScope(req)))) {
      throw new ForbiddenError('Недостаточно прав для проверки наличия');
    }
    if (req.warehouseId) {
      const [assigned] = await tx.select({ userId: schema.warehouseResponsibles.userId })
        .from(schema.warehouseResponsibles)
        .where(and(eq(schema.warehouseResponsibles.warehouseId, req.warehouseId), eq(schema.warehouseResponsibles.holdingId, req.holdingId)))
        .limit(1);
      if (assigned && assigned.userId !== input.actor.id) throw new ForbiddenError('Эта заявка направлена ответственному другого склада');
    }
    const [item] = await tx
      .select()
      .from(schema.requestItems)
      .where(and(eq(schema.requestItems.id, input.itemId), eq(schema.requestItems.requestId, req.id)));
    if (!item) throw new NotFoundError('Позиция не найдена');
    const status = input.inStock ? 'in_stock' : 'out_of_stock';
    await tx.update(schema.requestItems).set({ status }).where(eq(schema.requestItems.id, item.id));
    return { itemId: item.id, status };
  });
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
      const placement = await initialPlacement(
        tx,
        req.workflowId,
        reqContext(req),
        req.requesterId,
        req.holdingId,
        input.actor.id,
        reqScope(req),
      );
      for (const s of placement.skipped) {
        await tx.insert(schema.requestStatusHistory).values({
          requestId: req.id,
          oldStatus: req.status,
          newStatus: statusForStep(s),
          changedBy: null,
          source: 'auto_skip',
          comment: `Шаг «${s.stepName}» пропущен: заявитель создал заявку сам и отвечает за этот этап`,
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
    // «Закуплено» имеет смысл только после выбора поставщика — зеркало фильтра
    // availableActions, чтобы действие нельзя было вызвать напрямую через API.
    if (def.needsSelectedQuote && !(await hasSelectedQuote(tx, req.id))) {
      throw new ConflictError('Сначала должен быть выбран поставщик (КП)');
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
    if (def.comment && !String(input.comment ?? '').trim()) {
      throw new ValidationError('Требуется комментарий');
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const warnings: string[] = [];

    if (def.setInStock !== undefined) patch.inStock = def.setInStock;
    // #10 «Оформление заказа» — под-статус (ordered/sent/delivered/problem).
    if (def.setOrderStatus) patch.orderStatus = def.setOrderStatus;

    // #3 «Частично в наличии»: делим заявку — out-of-stock позиции уходят в новую
    // связанную заявку в закупку, исходная остаётся с in-stock и идёт на выдачу.
    if (def.perItem && step.stepKind === 'warehouse_check' && input.action === 'wh_partial') {
      const split = await applyPartialStockSplit(tx, req, step, input.actor.id);
      patch.inStock = split.parentInStock;
      if (split.childId) warnings.push(`Недостающие позиции вынесены в новую заявку ${split.childNumber}`);
      // If nothing was out of stock the split degrades to a plain in-stock verdict;
      // if EVERYTHING was out of stock, parentInStock=false routes the whole order on.
    }

    // Procurement: 'add' records a real КП; 'select' picks one and locks the amount.
    if (def.quote === 'add') {
      const items = await tx.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
      const byId = new Map(items.map((it: any) => [it.id, it]));
      const quoteItems = Array.isArray(input.quoteItems) ? input.quoteItems : [];
      const suppliedPhone = String(input.supplierPhone ?? '').trim();
      if (suppliedPhone) {
        const suppliedName = String(input.supplierName ?? '').trim();
        const normalizedPhone = normalizePhone(suppliedPhone);
        if (!suppliedName) throw new ValidationError('Укажите имя поставщика');
        if (normalizedPhone.length < 7) throw new ValidationError('Укажите корректный номер поставщика');
        let [supplier] = await tx.select().from(schema.suppliers).where(and(
          eq(schema.suppliers.holdingId, req.holdingId), eq(schema.suppliers.normalizedPhone, normalizedPhone),
        )).limit(1);
        if (!supplier) {
          const inserted = await tx.insert(schema.suppliers).values({
            holdingId: req.holdingId, name: suppliedName, phone: normalizedPhone, normalizedPhone, status: 'active',
          }).onConflictDoNothing({ target: [schema.suppliers.holdingId, schema.suppliers.normalizedPhone] }).returning();
          supplier = inserted[0] ?? (await tx.select().from(schema.suppliers).where(and(
            eq(schema.suppliers.holdingId, req.holdingId), eq(schema.suppliers.normalizedPhone, normalizedPhone),
          )).limit(1))[0];
        } else if (supplier.status !== 'active') {
          [supplier] = await tx.update(schema.suppliers).set({ status: 'active', updatedAt: new Date() })
            .where(eq(schema.suppliers.id, supplier.id)).returning();
        }
        input.supplierId = supplier.id;
        input.supplierName = supplier.name;
      }
      let ndsIncluded = !!input.ndsIncluded;
      let amt = Math.max(0, Math.round(Number(input.amount) || 0));
      if (quoteItems.length > 0) {
        if (quoteItems.length !== items.length) throw new ValidationError('Укажите цену для каждой позиции');
        let sum = 0;
        const itemSuppliers: { name: string; id: string | null }[] = [];
        for (const qi of quoteItems) {
          const item = byId.get(qi.itemId) as any;
          if (!item) throw new ValidationError('Позиция КП не найдена в заявке');
          const unitPrice = Number(qi.unitPrice);
          if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new ValidationError('Цена позиции должна быть неотрицательным числом');
          let itemSupplierName = String(input.supplierName ?? qi.supplierName ?? '').trim();
          let itemSupplierId: string | null = input.supplierId ? String(input.supplierId) : qi.supplierId ? String(qi.supplierId) : null;
          if (itemSupplierId) {
            const [sup] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, itemSupplierId));
            if (!sup || sup.holdingId !== req.holdingId) throw new ValidationError('Поставщик не найден');
            itemSupplierName = sup.name;
          }
          const base = Number(item.quantity) * unitPrice;
          const lineTotal = Math.round(base);
          const itemNdsIncluded = !!qi.ndsIncluded;
          const itemPaymentType = String(qi.paymentType ?? '').trim();
          if (!itemPaymentType) throw new ValidationError('Укажите тип оплаты для каждой позиции');
          sum += lineTotal;
          if (itemNdsIncluded) ndsIncluded = true;
          if (!input.paymentType) input.paymentType = itemPaymentType;
          if (itemSupplierName) itemSuppliers.push({ name: itemSupplierName, id: itemSupplierId });
          await tx
            .update(schema.requestItems)
            .set({
              estimatedPrice: Math.round(unitPrice),
              totalAmount: lineTotal,
              supplierName: itemSupplierName || null,
              supplierId: itemSupplierId,
              ndsIncluded: itemNdsIncluded,
              paymentType: itemPaymentType,
            })
            .where(eq(schema.requestItems.id, item.id));
        }
        amt = Math.round(sum);
        const uniqueSuppliers = [...new Set(itemSuppliers.map((s) => s.name))];
        if (!input.supplierName && !input.supplierId) {
          input.supplierName = uniqueSuppliers.length === 1 ? uniqueSuppliers[0] : uniqueSuppliers.length > 1 ? 'По позициям' : 'Не указан';
        }
      }
      if (!amt) throw new ValidationError('Укажите сумму КП');
      let supplierName = String(input.supplierName ?? '').trim();
      let supplierId: string | null = null;
      const paymentType = String(input.paymentType ?? '').trim() || null;
      // Preferred: a normalized supplier (validated within the holding). Legacy
      // free-text supplierName is kept as a snapshot / fallback.
      if (input.supplierId) {
        const [sup] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId));
        if (!sup || sup.holdingId !== req.holdingId) throw new ValidationError('Поставщик не найден');
        supplierId = sup.id;
        if (!supplierName) supplierName = sup.name;
      }
      if (!supplierName) supplierName = 'Не указан';
      await tx.update(schema.quotations).set({ selected: false }).where(eq(schema.quotations.requestId, req.id));
      const [quote] = await tx
        .insert(schema.quotations)
        .values({
          holdingId: req.holdingId,
          requestId: req.id,
          supplierId,
          supplierName,
          amount: amt,
          ndsIncluded,
          paymentType,
          leadTime: String(input.leadTime ?? '').trim() || null,
          // FIXES 2026-07-20 (тест): комментарий снабженца к КП сохраняется в
          // note — раньше терялся (quote.note всегда null).
          note: String(input.comment ?? '').trim() || null,
          selected: true,
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
        newValue: { supplierId, supplierName, amount: amt, ndsIncluded, paymentType },
        source: 'lifecycle',
      });
      patch.estimatedAmount = amt;
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
      if (assigneeId === req.requesterId) throw new ValidationError('Автор заявки не может быть выбран снабженцем');
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
            signatureType: 'internal_pin',
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
          signatureType: 'internal_pin',
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
    } else if (def.returnStep) {
      // #7/#8/#9 «Вернуть на пересмотр/поиск»: назад на более ранний применимый шаг
      // (step.onRejectStepOrder). Вперёд/на себя нельзя — это ошибка настройки.
      if (!req.workflowId || step.onRejectStepOrder == null) throw new ConflictError('Шаг возврата не настроен');
      const steps = await loadKindSteps(tx, req.workflowId);
      const target = (applicableSteps(steps, ctx) as KindStep[]).find(
        (s) => s.stepOrder === step.onRejectStepOrder && s.stepOrder < step.stepOrder,
      );
      if (!target) throw new ConflictError('Некорректный шаг возврата');
      to = statusForStep(target);
      newCurrentStepId = target.id;
      await enterApprovalIfNeeded(tx, req.id, target);
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
      // Keep creator and requester separate: an assistant-created request may not
      // self-skip approvals merely because the selected requester holds the role.
      const creatorId = await originalCreatorId(tx, req.id, req.requesterId);
      const selfSkip = await resolveSkippingSelfApprovals(
        tx,
        steps,
        ctx,
        req.requesterId,
        req.holdingId,
        next,
        creatorId,
        reqScope(req),
      );
      next = selfSkip.step;
      for (const s of selfSkip.skipped) {
        await tx.insert(schema.requestStatusHistory).values({
          requestId: req.id,
          oldStatus: from,
          newStatus: statusForStep(s),
          changedBy: null,
          source: 'auto_skip',
          comment: `Шаг «${s.stepName}» пропущен: заявитель создал заявку сам и отвечает за этот этап`,
        });
      }
      if (next) {
        to = statusForStep(next);
        newCurrentStepId = next.id;
        await enterApprovalIfNeeded(tx, req.id, next);
      } else {
        // A chain that ends after physical fulfilment (receiving/issue/close) is CLOSED;
        // ending anywhere earlier means "approved but not fulfilled". (L3)
        to =
          ['close', 'issue', 'receiving'].includes(step.stepKind) || (step.stepKind === 'warehouse_check' && ctx.inStock === true)
            ? TERMINAL_CLOSED
            : TERMINAL_APPROVED;
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
      // #11 приёмка: фиксируем фактически принятое количество на каждую позицию —
      // «полностью» = заказанное, «частично/с расхождением» = из payload receipts.
      if (step.stepKind === 'receiving') {
        const receipts = new Map<string, number>((input.receipts ?? []).map((r) => [r.itemId, Math.max(0, Number(r.receivedQty) || 0)]));
        for (const item of items) {
          const rq = def.perItem && receipts.has(item.id) ? receipts.get(item.id)! : Number(item.quantity);
          item.receivedQty = String(rq) as any;
          await tx
            .update(schema.requestItems)
            .set({ receivedQty: String(rq), status: rq >= Number(item.quantity) ? 'received' : 'short' })
            .where(eq(schema.requestItems.id, item.id));
          if (def.perItem && rq < Number(item.quantity)) warnings.push(`«${item.name}»: принято ${rq} из ${Number(item.quantity)}`);
        }
      }
      // Per-item quantity that moves stock: on receiving we credit what actually
      // arrived (received_qty); on issue we draw what's on hand for the item
      // (received_qty if it was received, else the ordered quantity for in-stock).
      const itemQty = (item: { quantity: unknown; receivedQty: unknown }): number => {
        if (step.stepKind === 'receiving') return Number(item.receivedQty);
        const rec = Number(item.receivedQty);
        return rec > 0 ? rec : Number(item.quantity);
      };
      // Aggregate quantities by materialId so duplicate rows don't cause
      // multiple independent stock ops for the same material.
      const byMaterial = new Map<string, number>();
      const skipped: string[] = [];
      for (const item of items) {
        const qty = itemQty(item);
        if (!item.materialId || !qty || qty <= 0) {
          if (item.materialId && qty <= 0) continue; // received 0 → nothing to book, not an error
          if (!item.materialId) skipped.push(item.name);
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
