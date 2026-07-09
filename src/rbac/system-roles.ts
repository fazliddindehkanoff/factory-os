/**
 * Built-in (system) roles seeded for every deployment. They are a sensible default
 * mapping ported from the legacy app; tenants can clone/override them via the admin
 * constructor without touching code. `'all'` grants every permission.
 */
export interface SystemRoleDef {
  code: string;
  name: string;
  permissions: string[] | 'all';
}

export const SYSTEM_ROLES: SystemRoleDef[] = [
  { code: 'owner', name: 'Учредитель', permissions: 'all' },
  {
    code: 'admin',
    name: 'Администратор',
    permissions: [
      'reports.status_summary',
      'users.view',
      'users.manage',
      'roles.manage',
      'workflows.manage',
      'settings.manage',
      'audit.view',
      'requests.view',
      'reports.view',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    code: 'director',
    name: 'Директор',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'approvals.approve',
      'approvals.reject',
      'approvals.override',
      'finance.view',
      'audit.view',
      'reports.view',
      'users.view',
    ],
  },
  {
    code: 'finance',
    name: 'Финансист',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'approvals.approve',
      'approvals.reject',
      'finance.view',
      'finance.mark_paid',
    ],
  },
  {
    code: 'procurement',
    name: 'Снабжение',
    // Выбор поставщика — ТОЛЬКО у руководителя снабжения (решение владельца
    // 2026-07-06): отдел собирает КП, руководитель выбирает.
    permissions: [
      'reports.status_summary',
      'requests.view',
      'procurement.view',
      'procurement.quote',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    code: 'warehouse',
    name: 'Склад',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'approvals.approve',
      'approvals.reject',
      'warehouse.view',
      'warehouse.check_stock',
      'warehouse.receive',
      'warehouse.issue',
    ],
  },
  {
    code: 'dept_head',
    name: 'Руководитель отдела',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'requests.create',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'requester',
    name: 'Заявитель',
    permissions: ['requests.view', 'requests.create', 'requests.upload_attachment'],
  },
  {
    code: 'warehouse_worker',
    name: 'Работник склада',
    permissions: [
      'reports.status_summary','requests.view', 'warehouse.view', 'warehouse.check_stock', 'warehouse.receive', 'warehouse.issue'],
  },
  {
    code: 'procurement_head',
    name: 'Руководитель снабжения',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'reports.view',
      'procurement.view',
      'procurement.quote',
      'procurement.select_supplier',
      'suppliers.view',
      'suppliers.manage',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'finance_head',
    name: 'Руководитель финансов',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'reports.view',
      'finance.view',
      'finance.mark_paid',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'deputy_director',
    name: 'Заместитель директора',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'reports.view',
      'finance.view',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'operations_lead',
    name: 'Руководитель внедрения',
    permissions: [
      'reports.status_summary',
      'requests.view',
      'requests.create',
      'reports.view',
      'audit.view',
      'warehouse.view',
      'procurement.view',
      'finance.view',
      'workflows.manage',
      'settings.manage',
    ],
  },
  {
    code: 'procurement_manager',
    name: 'Менеджер по снабжению',
    // Собирает КП; выбор поставщика — только procurement_head (2026-07-06).
    permissions: [
      'reports.status_summary',
      'requests.view',
      'procurement.view',
      'procurement.quote',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    code: 'finance_manager',
    name: 'Финансовый менеджер',
    permissions: [
      'reports.status_summary','requests.view', 'finance.view', 'finance.mark_paid'],
  },
  {
    code: 'accountant',
    name: 'Бухгалтер',
    permissions: [
      'reports.status_summary','requests.view', 'finance.view'],
  },
  {
    code: 'auditor',
    name: 'Аудитор',
    permissions: [
      'reports.status_summary','requests.view', 'reports.view', 'audit.view', 'suppliers.view'],
  },
  {
    code: 'observer',
    name: 'Наблюдатель',
    permissions: [
      'reports.status_summary','requests.view', 'reports.view'],
  },
];
