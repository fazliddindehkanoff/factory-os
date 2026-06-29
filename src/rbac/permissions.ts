/**
 * Permission catalog — the closed set of granular permission codes the system
 * recognizes. Roles are mapped to these codes (in any combination) via the admin
 * constructor; nothing is hardcoded to a role name. Adding a capability = adding
 * a code here and granting it to roles.
 */
export interface PermissionDef {
  code: string;
  name: string;
  module: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // requests
  { code: 'requests.view', name: 'Просмотр заявок', module: 'requests' },
  { code: 'requests.create', name: 'Создание заявок', module: 'requests' },
  { code: 'requests.edit', name: 'Редактирование заявок', module: 'requests' },
  { code: 'requests.comment', name: 'Комментирование заявок', module: 'requests' },
  { code: 'requests.upload_attachment', name: 'Загрузка вложений', module: 'requests' },
  // approvals
  { code: 'approvals.view', name: 'Просмотр согласований', module: 'approvals' },
  { code: 'approvals.approve', name: 'Согласование', module: 'approvals' },
  { code: 'approvals.reject', name: 'Отклонение', module: 'approvals' },
  { code: 'approvals.override', name: 'Override (учредитель)', module: 'approvals' },
  // warehouse
  { code: 'warehouse.view', name: 'Просмотр склада', module: 'warehouse' },
  { code: 'warehouse.check_stock', name: 'Проверка наличия', module: 'warehouse' },
  { code: 'warehouse.reserve', name: 'Резервирование', module: 'warehouse' },
  { code: 'warehouse.receive', name: 'Приёмка', module: 'warehouse' },
  { code: 'warehouse.issue', name: 'Выдача со склада', module: 'warehouse' },
  { code: 'warehouse.adjust', name: 'Корректировка остатков', module: 'warehouse' },
  // procurement
  { code: 'procurement.view', name: 'Просмотр закупок', module: 'procurement' },
  { code: 'procurement.quote', name: 'Ввод КП', module: 'procurement' },
  { code: 'procurement.select_supplier', name: 'Выбор поставщика', module: 'procurement' },
  { code: 'procurement.manage', name: 'Управление закупками', module: 'procurement' },
  // suppliers
  { code: 'suppliers.view', name: 'Просмотр поставщиков', module: 'suppliers' },
  { code: 'suppliers.manage', name: 'Управление поставщиками', module: 'suppliers' },
  // finance
  { code: 'finance.view', name: 'Просмотр финансов', module: 'finance' },
  { code: 'finance.mark_paid', name: 'Отметка об оплате', module: 'finance' },
  { code: 'finance.approve_payment', name: 'Согласование оплаты', module: 'finance' },
  // admin
  { code: 'users.view', name: 'Просмотр пользователей', module: 'admin' },
  { code: 'users.manage', name: 'Управление пользователями', module: 'admin' },
  { code: 'roles.manage', name: 'Управление ролями/правами', module: 'admin' },
  { code: 'workflows.manage', name: 'Управление workflow', module: 'admin' },
  { code: 'settings.view', name: 'Просмотр настроек', module: 'admin' },
  { code: 'settings.manage', name: 'Управление настройками', module: 'admin' },
  // audit / reports
  { code: 'audit.view', name: 'Просмотр аудита', module: 'audit' },
  { code: 'audit.export', name: 'Экспорт аудита', module: 'audit' },
  { code: 'reports.view', name: 'Просмотр отчётов', module: 'reports' },
];

export const PERMISSION_CODES: string[] = PERMISSIONS.map((p) => p.code);
