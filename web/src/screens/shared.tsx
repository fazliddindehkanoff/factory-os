/** Shared types, helpers and small UI bits used across screens. */
import { type CSSProperties, type ReactNode } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────
export interface Me {
  user: { id: string; fullName: string; holdingId: string | null; roleName?: string | null };
  permissions: string[];
}
export interface RequestRow {
  id: string;
  requestNumber: string;
  status: string;
  estimatedAmount: number;
  title: string | null;
  createdAt: string;
}
export interface ApprovalRow { id: string; status: string; }
export interface LifecycleActionBtn {
  action: string;
  label: string;
  pin: boolean;
  comment: boolean;
  amount: boolean;
  quote?: 'add' | 'select' | null;
}
export interface QuotationRow {
  id: string;
  supplierName: string;
  amount: number;
  leadTime: string | null;
  note: string | null;
  selected: boolean;
}
export interface StatusHistoryRow {
  id: string;
  oldStatus: string | null;
  newStatus: string;
  comment: string | null;
  createdAt: string;
  changedByName?: string | null;
  changedByRole?: string | null;
}
export interface RequestDetail extends RequestRow {
  items: { id: string; name: string; quantity: string; totalAmount: number }[];
  approvals: ApprovalRow[];
  statusLabel?: string;
  statusHistory?: StatusHistoryRow[];
  quotations?: QuotationRow[];
  actions?: LifecycleActionBtn[];
}
export type Screen =
  | { name: 'home' }
  | { name: 'list' }
  | { name: 'create' }
  | { name: 'detail'; id: string }
  | { name: 'approvals' }
  | { name: 'warehouse' }
  | { name: 'menu' }
  | { name: 'admin' };

export interface DashboardData {
  myActive: number;
  pendingForMe: number;
  totalActive: number;
  activity: { id: string; requestNumber: string; status: string; title: string | null }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0);

export const ADMIN_PERMS = ['roles.manage', 'users.manage', 'workflows.manage', 'settings.manage'];
export const INBOX_ACTOR_PERMS = [
  'approvals.approve', 'warehouse.check_stock',
  'warehouse.receive', 'warehouse.issue', 'procurement.quote',
  'procurement.select_supplier', 'finance.mark_paid',
];

export function roleLabel(perms: string[], roleName?: string | null): string {
  if (roleName) return roleName;
  if (perms.includes('approvals.override')) return 'Учредитель';
  if (perms.includes('roles.manage') || perms.includes('settings.manage')) return 'Администратор';
  if (perms.includes('finance.mark_paid')) return 'Финансы';
  if (perms.includes('procurement.select_supplier')) return 'Закупки';
  if (perms.includes('warehouse.issue')) return 'Склад';
  if (perms.includes('approvals.approve')) return 'Согласующий';
  if (perms.includes('requests.create')) return 'Заявитель';
  return 'Сотрудник';
}

export function statusMeta(status: string): { label: string; color: string; bg: string } {
  switch (status) {
    case 'warehouse_check': return { label: 'Проверка склада', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'in_stock': return { label: 'В наличии', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'partially_available': return { label: 'Частично в наличии', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'out_of_stock': return { label: 'Нет в наличии', color: 'var(--danger)', bg: 'var(--danger-bg)' };
    case 'procurement': return { label: 'В закупке', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'quotation_received': return { label: 'Получены КП', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'approval_pending': case 'pending_approval': return { label: 'На согласовании', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'needs_revision': return { label: 'На доработке', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'approved': return { label: 'Согласована', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'rejected': return { label: 'Отклонена', color: 'var(--danger)', bg: 'var(--danger-bg)' };
    case 'paid': return { label: 'Оплачена', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'in_delivery': return { label: 'В доставке', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'warehouse_receiving': return { label: 'Приёмка на складе', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'finance_payment': return { label: 'Ожидает оплаты', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'delivery': return { label: 'Доставка', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'receiving': return { label: 'Приёмка', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'issue': return { label: 'Выдача', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'accepted_to_warehouse': return { label: 'Принята на склад', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'issued': return { label: 'Выдана в отдел', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'closed': return { label: 'Закрыта', color: 'var(--fg3)', bg: 'var(--chip)' };
    case 'draft': return { label: 'Черновик', color: 'var(--fg3)', bg: 'var(--chip)' };
    default: return { label: status, color: 'var(--fg2)', bg: 'var(--chip)' };
  }
}

export function progressOf(status: string): string {
  switch (status) {
    case 'draft': case 'needs_revision': return '8%';
    case 'warehouse_check': return '20%';
    case 'in_stock': case 'partially_available': case 'out_of_stock': return '40%';
    case 'procurement': case 'quotation_received': return '60%';
    case 'approval_pending': case 'pending_approval': return '80%';
    case 'approved': return '100%';
    case 'paid': case 'finance_payment': return '88%';
    case 'in_delivery': case 'delivery': return '91%';
    case 'warehouse_receiving': case 'receiving': return '94%';
    case 'accepted_to_warehouse': return '96%';
    case 'issued': case 'issue': return '98%';
    case 'closed': case 'rejected': return '100%';
    default: return '30%';
  }
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

export function StatusPill({ status }: { status: string }) {
  const s = statusMeta(status);
  return (
    <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, background: s.bg, color: s.color, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color }} />
      {s.label}
    </span>
  );
}

export function Err({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-xl bg-danger/15 px-3 py-2.5 text-sm text-danger">{children}</div>;
}
export function Note({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-xl bg-warning/15 px-3 py-2.5 text-sm text-warning">{children}</div>;
}
export function Skeleton() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-card" />
      ))}
    </div>
  );
}
export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-6 text-fg2">{children}</div>;
}

export const SECTION_LABEL: CSSProperties = {
  fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--fg2)', marginBottom: 12,
};

export function actionBtnStyle(action: string): CSSProperties {
  const base: CSSProperties = { flex: 1, minWidth: 130, padding: 14, borderRadius: 12, border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
  if (action === 'approve') return { ...base, background: 'var(--success)', color: '#fff', boxShadow: '0 8px 18px -8px var(--success)' };
  if (action === 'reject') return { ...base, background: 'var(--danger-bg)', color: 'var(--danger)' };
  return { ...base, background: 'var(--accent)', color: '#fff', boxShadow: '0 8px 18px -8px var(--accent)' };
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const dmy = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (sameDay(d, now)) return `Сегодня · ${dmy}`;
  if (sameDay(d, y)) return `Вчера · ${dmy}`;
  return dmy;
}

export function groupByDay(rows: RequestRow[]): { key: string; label: string; items: RequestRow[] }[] {
  const groups: { key: string; label: string; items: RequestRow[] }[] = [];
  for (const r of rows) {
    const d = r.createdAt ? new Date(r.createdAt) : null;
    const key = d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(r);
    else groups.push({ key, label: r.createdAt ? dayLabel(r.createdAt) : 'Без даты', items: [r] });
  }
  return groups;
}

export function DateDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px 0' }}>
      <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
      <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fg3)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
    </div>
  );
}

export function actTint(status: string): { tint: string; ic: string } {
  switch (status) {
    case 'approved': return { tint: 'success', ic: 'check' };
    case 'rejected': return { tint: 'danger', ic: 'x' };
    case 'pending_approval': return { tint: 'warning', ic: 'checkCircle' };
    default: return { tint: 'accent', ic: 'file' };
  }
}

export const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Черновик', cls: 'bg-fg3/20 text-fg2' },
  pending_approval: { label: 'На согласовании', cls: 'bg-warning/15 text-warning' },
  needs_revision: { label: 'На доработке', cls: 'bg-warning/15 text-warning' },
  approved: { label: 'Согласована', cls: 'bg-success/15 text-success' },
  rejected: { label: 'Отклонена', cls: 'bg-danger/15 text-danger' },
};
export const statusOf = (s: string) => STATUS[s] ?? { label: s, cls: 'bg-fg3/20 text-fg2' };
