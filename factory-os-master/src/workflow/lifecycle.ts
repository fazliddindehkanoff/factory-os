/**
 * Minimal request-lifecycle status engine for the first vertical slice:
 *   warehouse_check → (in_stock | partial | out_of_stock)
 *     in_stock → reserve → approval_pending
 *     partial/out → procurement → quotation_received → select_supplier → approval_pending
 *   approval_pending → approve (PIN) | reject (comment)
 *
 * Each action declares the statuses it is valid FROM, the resulting status, the
 * permission it needs, and whether it requires a PIN / comment. The service layer
 * enforces all of this plus scope + writes status history + DNA audit log.
 */
export interface LifecycleAction {
  action: string;
  label: string;
  from: string[];
  to: string;
  perm: string;
  pin?: boolean;
  comment?: boolean;
  amount?: boolean; // requires entering a sum (sets the request's estimatedAmount)
  quote?: 'add' | 'select'; // procurement: 'add' creates a КП row, 'select' picks one
}

export const INITIAL_STATUS = 'warehouse_check';

export const LIFECYCLE: LifecycleAction[] = [
  { action: 'wh_in_stock', label: 'В наличии', from: ['warehouse_check'], to: 'in_stock', perm: 'warehouse.check_stock' },
  { action: 'wh_partial', label: 'Частично в наличии', from: ['warehouse_check'], to: 'partially_available', perm: 'warehouse.check_stock' },
  { action: 'wh_out', label: 'Нет в наличии', from: ['warehouse_check'], to: 'out_of_stock', perm: 'warehouse.check_stock' },
  { action: 'reserve', label: 'Зарезервировать', from: ['in_stock'], to: 'approval_pending', perm: 'warehouse.reserve' },
  { action: 'to_procurement', label: 'Передать в закупку', from: ['partially_available', 'out_of_stock'], to: 'procurement', perm: 'warehouse.check_stock' },
  { action: 'add_quotation', label: 'Добавить КП', from: ['procurement', 'quotation_received'], to: 'quotation_received', perm: 'procurement.quote', quote: 'add' },
  { action: 'select_supplier', label: 'Выбрать поставщика', from: ['quotation_received'], to: 'approval_pending', perm: 'procurement.select_supplier', quote: 'select' },
  { action: 'approve', label: 'Согласовать', from: ['approval_pending'], to: 'approved', perm: 'approvals.approve', pin: true },
  { action: 'reject', label: 'Отклонить', from: ['approval_pending'], to: 'rejected', perm: 'approvals.reject', comment: true },
  // ── Post-approval: finance → delivery → receiving → issue → close ──
  { action: 'mark_paid', label: 'Отметить оплату', from: ['approved'], to: 'paid', perm: 'finance.mark_paid', pin: true },
  { action: 'set_delivery', label: 'В доставку', from: ['paid'], to: 'in_delivery', perm: 'procurement.view' },
  { action: 'mark_arrived', label: 'Прибыло на склад', from: ['in_delivery'], to: 'warehouse_receiving', perm: 'warehouse.receive' },
  { action: 'receive_goods', label: 'Принять товар', from: ['warehouse_receiving'], to: 'accepted_to_warehouse', perm: 'warehouse.receive' },
  { action: 'issue', label: 'Выдать в отдел', from: ['accepted_to_warehouse'], to: 'issued', perm: 'warehouse.issue' },
  { action: 'close', label: 'Подтвердить получение и закрыть', from: ['issued'], to: 'closed', perm: 'requests.create' },
];

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  warehouse_check: 'Проверка склада',
  in_stock: 'В наличии',
  partially_available: 'Частично в наличии',
  out_of_stock: 'Нет в наличии',
  procurement: 'В закупке',
  quotation_received: 'Получены КП',
  approval_pending: 'На согласовании',
  approved: 'Согласована',
  rejected: 'Отклонена',
  paid: 'Оплачена',
  in_delivery: 'В доставке',
  warehouse_receiving: 'Приёмка на складе',
  accepted_to_warehouse: 'Принята на склад',
  issued: 'Выдана в отдел',
  closed: 'Закрыта',
};

export const actionsFromStatus = (status: string): LifecycleAction[] => LIFECYCLE.filter((a) => a.from.includes(status));
export const findAction = (action: string): LifecycleAction | undefined => LIFECYCLE.find((a) => a.action === action);
