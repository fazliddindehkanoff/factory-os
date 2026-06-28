/**
 * Dashboard composition — the seed of the per-screen config the admin panel will edit.
 *
 * Today this is a static default ported from the design's per-role home. The seam is
 * deliberate: each card/action is data (permission gate, label, tint, icon, target),
 * not hardcoded markup — so an admin "screen editor" can later persist and override
 * this (e.g. from /api/admin/settings) without touching the React components.
 *
 * `valueKey` binds a card to a real metric returned by GET /api/dashboard. Richer
 * per-role metrics (low stock, budget %, etc.) need backend support and are not faked.
 */
export type ScreenTarget = 'home' | 'list' | 'create' | 'admin';

export interface StatDef {
  perm: string;
  valueKey: 'myActive' | 'pendingForMe' | 'totalActive';
  label: string;
  tint: string;
  ic: string;
  go: ScreenTarget;
}

export interface ActionDef {
  perm: string;
  label: string;
  tint: string;
  ic: string;
  go: ScreenTarget;
}

export const DASHBOARD_STATS: StatDef[] = [
  { perm: 'requests.view', valueKey: 'myActive', label: 'Мои заявки', tint: 'accent', ic: 'file', go: 'list' },
  { perm: 'approvals.approve', valueKey: 'pendingForMe', label: 'Ожидают меня', tint: 'warning', ic: 'checkCircle', go: 'list' },
  { perm: 'reports.view', valueKey: 'totalActive', label: 'Активных всего', tint: 'success', ic: 'box', go: 'list' },
];

export const DASHBOARD_ACTIONS: ActionDef[] = [
  { perm: 'requests.create', label: 'Новая заявка', tint: 'accent', ic: 'plus', go: 'create' },
  { perm: 'requests.view', label: 'Все заявки', tint: 'success', ic: 'file', go: 'list' },
];
