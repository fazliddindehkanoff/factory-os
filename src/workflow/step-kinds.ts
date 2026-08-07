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
  | 'procurement_intake'
  | 'procurement'
  | 'price_approval'
  | 'finance_payment'
  | 'ordering'
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
   * №11: return the request to its author for revision (status needs_revision)
   * with a MANDATORY comment saying what to fix — independent of the step's
   * on_reject policy. The author edits and resubmits; the route re-runs from
   * the first applicable step.
   */
  revision?: boolean;
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
  /**
   * Bug #8: assign a specific procurement person. Requires an `assigneeId`; sets
   * request.responsibleUserId so ONLY that person works the procurement step.
   */
  assign?: boolean;
  /**
   * Действие имеет смысл только когда поставщик по заявке УЖЕ выбран (есть
   * selected-КП). Так различаются два прохода закупки: первый (сбор КП → выбор
   * поставщика руководителем) и повторный («закупить и передать дальше») — без
   * этого после отзыва select_supplier у снабженца (2026-07-06) повторный шаг
   * закупки не имел для него ни одного продвигающего действия и заявка вставала.
   */
  needsSelectedQuote?: boolean;
  /**
   * Возврат на БОЛЕЕ РАННИЙ применимый шаг (step.onRejectStepOrder) — как ветка
   * on_reject='return_step', но отдельным действием (не «Отклонить»). Для #7/#8/#9:
   * «Вернуть на повторный поиск / пересмотр цены / пересмотр». Требует комментарий.
   */
  returnStep?: boolean;
  /** Предлагать выбор причины из пресетов (reject_reasons) вместо/вместе с комментарием. */
  reason?: boolean;
  /** Записать requests.order_status (#10: ordered/sent/delivered/problem). */
  setOrderStatus?: string;
  /**
   * Действие выполняется по КАЖДОМУ продукту заявки (кнопки в карточке позиции):
   * склад отмечает наличие/приёмку каждой позиции. UI шлёт per-item payload.
   */
  perItem?: boolean;
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

/**
 * №11: offered on decision steps alongside REJECT, to the same step handler.
 * Unlike reject it never kills the request — it hands it back to the author.
 */
const REVISE: StepActionDef = {
  action: 'return_revision',
  label: 'Вернуть на доработку',
  perm: 'approvals.reject',
  comment: true,
  revision: true,
  advance: true,
};

/**
 * Возврат на более ранний шаг (цена/поиск), с причиной. Используется директором /
 * исп. директором / руководителем снабжения. Цель — step.onRejectStepOrder.
 */
const RETURN_STEP: StepActionDef = {
  action: 'return_step',
  label: 'Вернуть на пересмотр',
  perm: 'approvals.reject',
  comment: true,
  reason: true,
  returnStep: true,
  advance: true,
};

/** «Вернуть на уточнение» — вариант REVISE с формулировкой для склада/снабжения. */
const REVISE_CLARIFY: StepActionDef = { ...REVISE, label: 'Вернуть на уточнение' };

export const STEP_KIND_ACTIONS: Record<StepKind, StepActionDef[]> = {
  // #2 Руководитель отдела / #4 Заместитель директора / #8 Исп. директор / #9 Директор.
  // RETURN_STEP («Вернуть на пересмотр») показывается только когда у шага задан
  // on_reject_step_order (директорские тиры) — см. availableActions.
  approval: [
    // Лист Excel №12: согласующий «одобряет» заявку — кнопка «Одобрить», не
    // «Согласовать» (этап в целом называется «Согласование», действие — одобрение).
    { action: 'approve', label: 'Одобрить', perm: 'approvals.approve', advance: true },
    // Bug #8: only surfaced when the NEXT step is procurement (see availableActions).
    { action: 'assign_procurement', label: 'Передать снабженцу', perm: 'approvals.approve', assign: true, advance: true },
    REVISE,
    RETURN_STEP,
    REJECT,
  ],
  // #3 Склад: наличие по каждому продукту. wh_partial дробит заявку (split).
  warehouse_check: [
    { action: 'wh_in_stock', label: 'Есть в наличии', perm: 'warehouse.check_stock', setInStock: true, sod: true, advance: true },
    { action: 'wh_partial', label: 'Частично в наличии', perm: 'warehouse.check_stock', perItem: true, sod: true, advance: true },
    { action: 'wh_out_of_stock', label: 'Нет в наличии', perm: 'warehouse.check_stock', setInStock: false, sod: true, advance: true },
    REVISE_CLARIFY,
    REJECT,
  ],
  // #5 Руководитель снабжения — принятие заявки в работу.
  procurement_intake: [
    { action: 'accept_to_work', label: 'Принять в работу', perm: 'procurement.view', advance: true },
    { action: 'assign_procurement', label: 'Назначить снабженца', perm: 'procurement.view', assign: true, advance: true },
    REVISE_CLARIFY,
    REJECT,
  ],
  // #6 Менеджер по снабжению — поиск поставщика.
  procurement: [
    { action: 'start_procurement', label: 'Я начал', perm: 'procurement.quote', setOrderStatus: 'started', advance: false },
    { action: 'add_quotation', label: 'Добавить предложение', perm: 'procurement.quote', amount: true, quote: 'add', advance: true },
    // FIXES 2026-07-20: выбор поставщика — ТОЛЬКО у руководителя снабжения
    // (procurement.select_supplier), менеджер собирает КП, но не выбирает.
    { action: 'select_supplier', label: 'Выбрать поставщика', perm: 'procurement.select_supplier', quote: 'select', sod: true, advance: false },
    { action: 'submit_for_approval', label: 'В процессе оплаты', perm: 'procurement.quote', needsSelectedQuote: true, sod: true, setOrderStatus: 'payment_in_progress', advance: true },
    // Повторный шаг закупки (поставщик уже выбран): закупить и двигать дальше.
    { action: 'mark_purchased', label: 'Закуплено — передать дальше', perm: 'procurement.quote', needsSelectedQuote: true, sod: true, advance: true },
    REVISE_CLARIFY,
    REJECT,
  ],
  // #7 Операционная проверка цены/переход дальше — у назначенного снабженца.
  price_approval: [
    { action: 'approve_price', label: 'Отправить предложение', perm: 'procurement.quote', setOrderStatus: 'payment_in_progress', advance: true },
    // FIXES 2026-07-20: руководитель снабжения ВЫБИРАЕТ понравившееся КП из
    // собранных на проверке цены (не только последнее авто-выбранное); дальше
    // директор и остальные роли видят только выбранное предложение.
    { action: 'select_supplier', label: 'Выбрать поставщика', perm: 'procurement.select_supplier', quote: 'select', sod: true, advance: false },
    // FIXES 2026-07-17 (лист G): «Пересмотреть цену» — возврат снабженцу на шаг
    // поиска с причиной из пресетов (Завышенная цена / Найти других поставщиков /
    // Найти на перечисление / Сделать конкурентный лист). Снабженец ставит новую
    // цену и возвращает на проверку.
    { action: 'return_research', label: 'Пересмотреть цену', perm: 'procurement.select_supplier', comment: true, reason: true, returnStep: true, advance: true },
    { action: 'reject_purchase', label: 'Отклонить закупку', perm: 'procurement.select_supplier', comment: true, reject: true, advance: true },
  ],
  finance_payment: [
    { action: 'mark_paid', label: 'Отметить оплату', perm: 'finance.mark_paid', sod: true, advance: true },
    REVISE,
    REJECT,
  ],
  // #10 Менеджер по снабжению — оформление и отправка заказа. Под-статусы в order_status.
  ordering: [
    { action: 'place_order', label: 'Оформить заказ', perm: 'procurement.quote', setOrderStatus: 'ordered', advance: true },
    { action: 'report_problem', label: 'Сообщить о проблеме', perm: 'procurement.quote', comment: true, setOrderStatus: 'problem', advance: false },
    REJECT,
  ],
  delivery: [
    { action: 'mark_arrived', label: 'В процессе доставки', perm: 'procurement.quote', setOrderStatus: 'delivery_in_progress', advance: true },
    REJECT,
  ],
  // #11 Склад — приёмка по каждому продукту (фактическое количество, расхождения).
  receiving: [
    { action: 'receive_full', label: 'Подтвердить приёмку', perm: 'warehouse.receive', advance: true },
    { action: 'receive_partial', label: 'Принять частично', perm: 'warehouse.receive', perItem: true, advance: true },
    { action: 'receive_discrepancy', label: 'Принять с расхождением', perm: 'warehouse.receive', perItem: true, comment: true, advance: true },
    { action: 'reject_receiving', label: 'Отказать в приёмке', perm: 'warehouse.receive', comment: true, reject: true, advance: true },
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
  procurement_intake: 'Принятие заявки (снабжение)',
  procurement: 'Поиск поставщика',
  price_approval: 'Проверка цены',
  finance_payment: 'Оплата',
  ordering: 'Оформление заказа',
  delivery: 'Доставка',
  receiving: 'Приёмка на склад',
  issue: 'Выдача в отдел',
  close: 'Подтверждение получения',
};

/** Terminal statuses a request can rest in once it leaves the configured chain. */
export const TERMINAL_APPROVED = 'approved';
export const TERMINAL_CLOSED = 'closed';
export const TERMINAL_REJECTED = 'rejected';
export const TERMINAL_CANCELLED = 'cancelled';
export const TERMINAL_ARCHIVED = 'archived';
export const TERMINAL_DELETED = 'deleted';

/**
 * Every status in which a request is finished / no longer in-flight. Single
 * source of truth — dashboards, workflow in-flight checks and override guards
 * all consult this so `closed`/`cancelled`/`archived` can never be forgotten in
 * one place and treated as "still active" in another. (P2-1)
 */
export const TERMINAL_STATUSES: readonly string[] = [
  TERMINAL_APPROVED,
  TERMINAL_CLOSED,
  TERMINAL_REJECTED,
  TERMINAL_CANCELLED,
  TERMINAL_ARCHIVED,
  TERMINAL_DELETED,
];

/** True if `status` is a finished/terminal request state. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** In-flight status name for an approval step (kept for compat with approval.service). */
export const STATUS_PENDING_APPROVAL = 'pending_approval';

/**
 * Не-терминальный статус «на доработке»: шаг с политикой return_requester
 * вернул заявку автору; автор правит и выполняет действие `resubmit`, которое
 * заново прокладывает маршрут с первого применимого шага.
 */
export const STATUS_NEEDS_REVISION = 'needs_revision';

/** Политика «Если отклонил» шага (workflow_steps.on_reject). */
export type OnRejectPolicy = 'cancel' | 'return_requester' | 'return_step';
export const ON_REJECT_POLICIES: readonly OnRejectPolicy[] = ['cancel', 'return_requester', 'return_step'];

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
  onReject?: OnRejectPolicy | string | null;
  onRejectStepOrder?: number | null;
}
