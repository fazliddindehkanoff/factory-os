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
      'requests.view',
      'approvals.view',
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
      'requests.view',
      'approvals.view',
      'approvals.approve',
      'approvals.reject',
      'finance.view',
      'finance.mark_paid',
    ],
  },
  {
    code: 'procurement',
    name: 'Снабжение',
    permissions: [
      'requests.view',
      'procurement.view',
      'procurement.quote',
      'procurement.select_supplier',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    code: 'warehouse',
    name: 'Склад',
    permissions: [
      'requests.view',
      'approvals.view',
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
      'requests.view',
      'requests.create',
      'approvals.view',
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
    permissions: ['requests.view', 'warehouse.view', 'warehouse.check_stock', 'warehouse.receive', 'warehouse.issue'],
  },
  {
    code: 'procurement_head',
    name: 'Руководитель снабжения',
    permissions: [
      'requests.view',
      'reports.view',
      'procurement.view',
      'procurement.quote',
      'procurement.select_supplier',
      'suppliers.view',
      'suppliers.manage',
      'approvals.view',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'finance_head',
    name: 'Руководитель финансов',
    permissions: [
      'requests.view',
      'reports.view',
      'finance.view',
      'finance.mark_paid',
      'approvals.view',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'deputy_director',
    name: 'Заместитель директора',
    permissions: [
      'requests.view',
      'reports.view',
      'finance.view',
      'approvals.view',
      'approvals.approve',
      'approvals.reject',
    ],
  },
  {
    code: 'operations_lead',
    name: 'Руководитель внедрения',
    permissions: [
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
    permissions: [
      'requests.view',
      'approvals.view',
      'procurement.view',
      'procurement.quote',
      'procurement.select_supplier',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    code: 'finance_manager',
    name: 'Финансовый менеджер',
    permissions: ['requests.view', 'approvals.view', 'finance.view', 'finance.mark_paid'],
  },
  {
    code: 'accountant',
    name: 'Бухгалтер',
    permissions: ['requests.view', 'finance.view'],
  },
  {
    code: 'auditor',
    name: 'Аудитор',
    permissions: ['requests.view', 'reports.view', 'audit.view', 'audit.export', 'suppliers.view'],
  },
  {
    code: 'observer',
    name: 'Наблюдатель',
    permissions: ['requests.view', 'reports.view'],
  },
];
