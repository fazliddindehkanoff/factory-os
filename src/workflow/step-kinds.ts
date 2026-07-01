/**
 * Step-kind registry — the data-driven replacement for the hardcoded LIFECYCLE
 * array. Each workflow step has a `stepKind`; this maps a kind to the action(s)
 * the step offers, the permission each needs, the input flags the UI must render
 * (PIN / comment / amount / quotation), and the side-effect the engine applies.
 *
 * The request path is therefore whatever the admin configured in the constructor:
 * the engine walks the workflow's applicable steps in order, and at each step the
 * available actions come from THIS table — not from a fixed status switch.
 *
 * Pure data + types (no DB) so it can be unit-tested exhaustively.
 */
import type { StepLike } from './engine.js';

export type StepKind =
  | 'approval'
  | 'warehouse_check'
  | 'procurement'
  | 'finance_payment'
  | 'delivery'
  | 'receiving'
  | 'issue'
  | 'close';

export interface StepActionDef {
  /** Unique action id sent by the client. */
  action: string;
  label: string;
  /** Permission the actor must hold (within request scope). */
  perm: string;
  pin?: boolean;
  comment?: boolean;
  amount?: boolean;
  quote?: 'add' | 'select';
  /** A reject action: ends the request as 'rejected' instead of advancing. */
  reject?: boolean;
  /**
   * Separation of duties: the requester may not perform this action on their own
   * request (money/routing decisions: payment, supplier choice, stock verdict).
   * 'approve' is always SoD-protected regardless of this flag.
   */
  sod?: boolean;
  /** Only the request's author may perform this action (receipt confirmation). */
  requesterOnly?: boolean;
  /**
   * For warehouse_check branching: records request.inStock so downstream steps
   * gated by { inStock: false } (procurement) include/skip themselves correctly.
   */
  setInStock?: boolean;
  /**
   * Whether performing this action advances to the next step. Some actions stay
   * on the same step (e.g. recording another quotation before a supplier is picked).
   */
  advance: boolean;
}

/**
 * Reject is offered on every in-flight step so a request can always be killed by
 * someone with reject authority. Defined once and shared.
 */
const REJECT: StepActionDef = {
  action: 'reject',
  label: 'Отклонить',
  perm: 'approvals.reject',
  comment: true,
  reject: true,
  advance: true,
};

export const STEP_KIND_ACTIONS: Record<StepKind, StepActionDef[]> = {
  approval: [
    { action: 'approve', label: 'Согласовать', perm: 'approvals.approve', pin: true, advance: true },
    REJECT,
  ],
  warehouse_check: [
    { action: 'wh_in_stock', label: 'В наличии', perm: 'warehouse.check_stock', setInStock: true, sod: true, advance: true },
    { action: 'wh_out_of_stock', label: 'Нет в наличии', perm: 'warehouse.check_stock', setInStock: false, sod: true, advance: true },
    REJECT,
  ],
  procurement: [
    { action: 'add_quotation', label: 'Добавить КП', perm: 'procurement.quote', amount: true, quote: 'add', advance: false },
    { action: 'select_supplier', label: 'Выбрать поставщика', perm: 'procurement.select_supplier', quote: 'select', sod: true, advance: true },
    REJECT,
  ],
  finance_payment: [
    { action: 'mark_paid', label: 'Отметить оплату', perm: 'finance.mark_paid', pin: true, sod: true, advance: true },
    REJECT,
  ],
  delivery: [
    { action: 'mark_arrived', label: 'Прибыло на склад', perm: 'warehouse.receive', advance: true },
    REJECT,
  ],
  receiving: [
    { action: 'receive_goods', label: 'Принять товар', perm: 'warehouse.receive', advance: true },
    REJECT,
  ],
  issue: [
    { action: 'issue', label: 'Выдать в отдел', perm: 'warehouse.issue', advance: true },
    REJECT,
  ],
  close: [
    // requesterOnly: receipt is confirmed by the request's author, not by any
    // holder of requests.create in the holding (B9).
    { action: 'close', label: 'Подтвердить получение', perm: 'requests.create', requesterOnly: true, advance: true },
  ],
};

/** Default human label for a step kind (fallback when a step has no stepName). */
export const STEP_KIND_LABELS: Record<StepKind, string> = {
  approval: 'Согласование',
  warehouse_check: 'Проверка склада',
  procurement: 'Закупка',
  finance_payment: 'Оплата',
  delivery: 'Доставка',
  receiving: 'Приёмка на склад',
  issue: 'Выдача в отдел',
  close: 'Подтверждение получения',
};

/** Terminal statuses a request can rest in once it leaves the configured chain. */
export const TERMINAL_APPROVED = 'approved';
export const TERMINAL_CLOSED = 'closed';
export const TERMINAL_REJECTED = 'rejected';

/** In-flight status name for an approval step (kept for compat with approval.service). */
export const STATUS_PENDING_APPROVAL = 'pending_approval';

/**
 * The request.status text while it sits on a given step. Approval steps use the
 * historical 'pending_approval' value (so both the lifecycle and the legacy
 * approval.service agree); every other kind uses its own kind as the status.
 */
export function statusForStep(step: { stepKind: string }): string {
  return step.stepKind === 'approval' ? STATUS_PENDING_APPROVAL : step.stepKind;
}

/** All valid step kinds (for admin-side validation and UI dropdowns). */
export const STEP_KINDS = Object.keys(STEP_KIND_ACTIONS) as StepKind[];

export function actionsForKind(kind: string): StepActionDef[] {
  return STEP_KIND_ACTIONS[kind as StepKind] ?? STEP_KIND_ACTIONS.approval;
}

export function findKindAction(kind: string, action: string): StepActionDef | undefined {
  return actionsForKind(kind).find((a) => a.action === action);
}

/** A step row carrying the kind — superset of the routing StepLike. */
export interface KindStep extends StepLike {
  stepKind: string;
  stepName?: string | null;
  approverRoleId?: string | null;
}
