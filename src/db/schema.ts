/**
 * Factory OS — Platform foundation schema (Phase 1).
 *
 * Scope of THIS file: multi-tenant org structure, identity, RBAC (roles/permissions
 * with scope), settings, and the immutable audit log. The request/workflow/approval
 * domain and warehouse/finance modules are added in their own phases.
 *
 * Principles (see docs 00_FOUNDATION_DECISIONS.md):
 *  - UUID primary keys.
 *  - Every business row is scoped by holding_id (and finer scope where relevant).
 *  - Timestamps are timestamptz, single source (DB now()).
 *  - Statuses use pgEnum where the set is stable; CHECK-like safety at the DB level.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Enums ────────────────────────────────────────────────────────────────────
export const entityStatus = pgEnum('entity_status', ['active', 'inactive', 'archived']);
export const userStatus = pgEnum('user_status', [
  'pending',
  'active',
  'suspended',
  'disabled',
  'archived',
]);
export const assignmentStatus = pgEnum('assignment_status', ['active', 'revoked', 'expired']);

// ── Tenancy: holding → company → factory → department / warehouse ─────────────
export const holdings = pgTable('holdings', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  country: text('country'),
  currency: text('currency').notNull().default('UZS'),
  timezone: text('timezone').notNull().default('Asia/Tashkent'),
  status: entityStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    inn: text('inn'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('companies_holding_idx').on(t.holdingId) }),
);

export const factories = pgTable(
  'factories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    name: text('name').notNull(),
    type: text('type'),
    address: text('address'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('factories_holding_idx').on(t.holdingId) }),
);

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    factoryId: uuid('factory_id').references(() => factories.id),
    name: text('name').notNull(),
    // Otdel name translations; RU stays on `name` above for backward compatibility.
    nameUz: text('name_uz'),
    nameTr: text('name_tr'),
    type: text('type'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('departments_holding_idx').on(t.holdingId) }),
);

// Otdel (department) <-> branch (factory) multi-assignment: one department can
// span several branches, and this is managed independently of the legacy single
// `departments.factoryId` column (kept for the existing Structure.tsx tree view).
export const departmentFactories = pgTable(
  'department_factories',
  {
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    factoryId: uuid('factory_id')
      .notNull()
      .references(() => factories.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.departmentId, t.factoryId] }) }),
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    factoryId: uuid('factory_id').references(() => factories.id),
    name: text('name').notNull(),
    nameUz: text('name_uz'),
    nameTr: text('name_tr'),
    type: text('type'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('warehouses_holding_idx').on(t.holdingId) }),
);

// Multilingual job titles. Users keep the legacy `position` text snapshot below
// for backward-compatible exports, while new UI/API writes use this stable FK.
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').notNull().references(() => holdings.id),
    nameRu: text('name_ru').notNull(),
    nameUz: text('name_uz').notNull(),
    nameTr: text('name_tr').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('positions_holding_idx').on(t.holdingId) }),
);

// ── Identity ─────────────────────────────────────────────────────────────────
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').references(() => holdings.id),
    telegramId: text('telegram_id').unique(),
    // The same person may authenticate through Telegram, the web dashboard, or both.
    username: text('username'),
    passwordHash: text('password_hash'),
    // Set whenever an admin assigns/resets a dashboard password on someone's
    // behalf (e.g. the phone-as-starting-password convenience) — cleared once
    // the user sets their own password via the self-service endpoint.
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    fullName: text('full_name').notNull(),
    // Normalized (digits-only, e.g. "998901234567") at every write site — see
    // src/utils/phone.ts. Admin-provisioned users are looked up by this from the
    // bot's /start contact-share flow, so it must stay unique and normalized.
    phone: text('phone').unique(),
    email: text('email'),
    position: text('position'),
    positionId: uuid('position_id').references(() => positions.id),
    pinHash: text('pin_hash'),
    status: userStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('users_holding_idx').on(t.holdingId) }),
);

// A warehouse has at most one currently responsible employee. A join table is
// used because warehouses are declared before users in the foundation schema.
export const warehouseResponsibles = pgTable(
  'warehouse_responsibles',
  {
    warehouseId: uuid('warehouse_id').primaryKey().references(() => warehouses.id, { onDelete: 'cascade' }),
    holdingId: uuid('holding_id').notNull().references(() => holdings.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('warehouse_responsibles_holding_idx').on(t.holdingId), userIdx: index('warehouse_responsibles_user_idx').on(t.userId) }),
);

// A user can belong to several otdels; the create-request department picker is
// restricted to these. Independent of userRoles' scoped assignments (RBAC).
export const userDepartments = pgTable(
  'user_departments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.departmentId] }) }),
);

// ── RBAC: roles, permissions, mappings, scoped assignments ───────────────────
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null holdingId = built-in system role shared across tenants
    holdingId: uuid('holding_id').references(() => holdings.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ codeIdx: uniqueIndex('roles_holding_code_idx').on(t.holdingId, t.code) }),
);

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  module: text('module').notNull(),
  description: text('description'),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    // Scope of this assignment. Coarser nulls = broader scope.
    holdingId: uuid('holding_id').references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    factoryId: uuid('factory_id').references(() => factories.id),
    departmentId: uuid('department_id').references(() => departments.id),
    status: assignmentStatus('status').notNull().default('active'),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index('user_roles_user_idx').on(t.userId) }),
);

// ── Settings (per holding) ───────────────────────────────────────────────────
export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').references(() => holdings.id),
    key: text('key').notNull(),
    value: text('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ keyIdx: uniqueIndex('settings_holding_key_idx').on(t.holdingId, t.key) }),
);

// ── Form builder: per-holding, admin-configurable form schemas ───────────────
// One row per field on a screen (e.g. 'request_create'). `system` fields map to
// real columns; non-system fields are stored in requests.custom_fields (jsonb).
export const formFields = pgTable(
  'form_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    screen: text('screen').notNull().default('request_create'),
    fieldKey: text('field_key').notNull(),
    label: text('label').notNull(),
    // text | textarea | number | select | date | checkbox | file
    fieldType: text('field_type').notNull(),
    system: boolean('system').notNull().default(false),
    required: boolean('required').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    placeholder: text('placeholder'),
    options: jsonb('options'), // select: [{ value, label, meta? }]
    stepGroup: integer('step_group').notNull().default(1),
    orderIndex: integer('order_index').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    screenIdx: index('form_fields_holding_screen_idx').on(t.holdingId, t.screen),
    keyIdx: uniqueIndex('form_fields_holding_screen_key_idx').on(t.holdingId, t.screen, t.fieldKey),
  }),
);

// ── Audit / DNA log (immutable) ──────────────────────────────────────────────
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    factoryId: uuid('factory_id').references(() => factories.id),
    userId: uuid('user_id').references(() => users.id),
    userRoleSnapshot: text('user_role_snapshot'),
    action: text('action').notNull(),
    module: text('module'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    comment: text('comment'),
    source: text('source'),
    deviceInfo: text('device_info'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    createdIdx: index('audit_logs_created_idx').on(t.createdAt),
    holdingIdx: index('audit_logs_holding_idx').on(t.holdingId),
  }),
);

// ── Domain enums ─────────────────────────────────────────────────────────────
export const priority = pgEnum('priority', ['low', 'normal', 'high', 'urgent', 'critical']);
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'viewed',
  'approved',
  'rejected',
  'changes_requested',
  'delegated',
  'expired',
  'skipped',
  'cancelled',
]);
export const approverType = pgEnum('approver_type', [
  'role',
  'user',
  'department_head',
  'factory_director',
  'finance_head',
  'custom',
]);
// What a workflow step DOES when the request reaches it. The data-driven engine
// reads this to know which action(s) the step offers and their side-effects, so
// the whole request path is configured in the admin constructor — not hardcoded.
export const stepKind = pgEnum('step_kind', [
  'approval', // role sign-off (PIN); advances when approved, terminal-rejects on reject
  'warehouse_check', // склад: «в наличии / частично / нет» — sets request.inStock, splits on partial
  'procurement_intake', // снабжение: принятие заявки в работу + назначение снабженца (#5)
  'procurement', // снабжение: add quotations (КП) + select/recommend supplier (#6)
  'price_approval', // руководитель снабжения: проверка цены и поставщика (#7)
  'finance_payment', // финансы: mark paid (PIN)
  'ordering', // снабжение: оформление/отправка заказа — order_status (#10)
  'delivery', // доставка: mark arrived
  'receiving', // приёмка на склад — по позициям, received_qty (#11)
  'issue', // выдача в отдел
  'close', // подтверждение получения — terminal (closed)
]);
export const signatureType = pgEnum('signature_type', [
  'internal_pin',
  'telegram_pin',
  'dashboard_pin',
]);

// ── Materials (minimal; full warehouse module comes in a later phase) ─────────
export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    name: text('name').notNull(),
    normalizedName: text('normalized_name'),
    sku: text('sku'),
    defaultUnit: text('default_unit'),
    category: text('category'),
    // Product title translations (name/RU above is the default; TR is the "original"
    // language of the source nomenclature import, UZ is filled in by admins over time).
    nameUz: text('name_uz'),
    nameTr: text('name_tr'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('materials_holding_idx').on(t.holdingId) }),
);

// ── Unit types (managed, orderable list — replaces free-text units in the UI) ─
export const unitTypes = pgTable(
  'unit_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    code: text('code').notNull(),
    nameRu: text('name_ru').notNull(),
    nameUz: text('name_uz'),
    nameTr: text('name_tr'),
    orderIndex: integer('order_index').notNull().default(0),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('unit_types_holding_idx').on(t.holdingId) }),
);

// ── Workflow engine (data-driven routing — the single source of truth) ────────
export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    name: text('name').notNull(),
    module: text('module').notNull().default('request'),
    requestType: text('request_type'),
    factoryId: uuid('factory_id').references(() => factories.id),
    departmentId: uuid('department_id').references(() => departments.id),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ holdingIdx: index('workflows_holding_idx').on(t.holdingId) }),
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    stepName: text('step_name').notNull(),
    // The step's behaviour. Defaults to 'approval' so existing/legacy steps keep
    // acting as role sign-offs; the engine derives the offered actions from this.
    stepKind: stepKind('step_kind').notNull().default('approval'),
    approverType: approverType('approver_type').notNull().default('role'),
    approverRoleId: uuid('approver_role_id').references(() => roles.id),
    approverUserId: uuid('approver_user_id').references(() => users.id),
    // Condition that gates this step, e.g. { "amountGte": 5000000 } or { "inStock": false }.
    conditionRule: jsonb('condition_rule'),
    thresholdAmount: bigint('threshold_amount', { mode: 'number' }),
    isRequired: boolean('is_required').notNull().default(true),
    // Admin can switch a stage off from the constructor; the engine then skips it.
    enabled: boolean('enabled').notNull().default(true),
    timeoutHours: integer('timeout_hours'),
    // Ветка «если отклонил»: cancel (заявка отклонена, как раньше) |
    // return_requester (на доработку автору, статус needs_revision + resubmit) |
    // return_step (вернуть на более ранний шаг onRejectStepOrder).
    onReject: text('on_reject').notNull().default('cancel'),
    onRejectStepOrder: integer('on_reject_step_order'),
  },
  (t) => ({ wfIdx: index('workflow_steps_wf_idx').on(t.workflowId) }),
);

export const approvalRules = pgTable('approval_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  holdingId: uuid('holding_id')
    .notNull()
    .references(() => holdings.id),
  name: text('name').notNull(),
  conditionRule: jsonb('condition_rule'),
  workflowId: uuid('workflow_id')
    .notNull()
    .references(() => workflows.id),
  priority: integer('priority').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

// ── Requests ─────────────────────────────────────────────────────────────────
export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestNumber: text('request_number').notNull(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    companyId: uuid('company_id').references(() => companies.id),
    factoryId: uuid('factory_id').references(() => factories.id),
    departmentId: uuid('department_id').references(() => departments.id),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id),
    responsibleUserId: uuid('responsible_user_id').references(() => users.id),
    requestType: text('request_type').notNull().default('material_request'),
    title: text('title'),
    description: text('description'),
    priority: priority('priority').notNull().default('normal'),
    // Free-text department/warehouse as entered in the create wizard (design contract).
    departmentName: text('department_name'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    warehouseName: text('warehouse_name'),
    // status is workflow-driven (dynamic), so it is text rather than a fixed enum.
    status: text('status').notNull().default('draft'),
    workflowId: uuid('workflow_id').references(() => workflows.id),
    currentStepId: uuid('current_step_id').references(() => workflowSteps.id),
    // Set by a warehouse_check step; gates downstream steps via conditionRule
    // { inStock: false } (procurement runs only when goods are NOT in stock).
    inStock: boolean('in_stock'),
    // Money in integer minor units (whole UZS). Never floats.
    estimatedAmount: bigint('estimated_amount', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('UZS'),
    neededDate: timestamp('needed_date', { withTimezone: true }),
    source: text('source'),
    // Split orders (2026-07-11): when the warehouse marks a multi-item order as
    // partially in stock, the out-of-stock items spin into a NEW order that points
    // back here. FK enforced in migration 0022 (self-reference).
    parentRequestId: uuid('parent_request_id'),
    // Ordering step (#10) sub-state: null | ordered | sent | delivered | problem.
    orderStatus: text('order_status'),
    // Values for admin-defined custom (non-system) form fields: { fieldKey: value }.
    customFields: jsonb('custom_fields'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    numberIdx: uniqueIndex('requests_holding_number_idx').on(t.holdingId, t.requestNumber),
    statusIdx: index('requests_status_idx').on(t.status),
    requesterIdx: index('requests_requester_idx').on(t.requesterId),
  }),
);

export const requestItems = pgTable(
  'request_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      // P1-8: RESTRICT, not cascade — business history (items, status history,
      // approvals, reservations, quotations, attachments) must never vanish when
      // a request row is deleted. Requests are archived, not hard-deleted.
      .references(() => requests.id, { onDelete: 'restrict' }),
    materialId: uuid('material_id').references(() => materials.id),
    name: text('name').notNull(),
    description: text('description'),
    quantity: numeric('quantity').notNull().default('0'),
    unit: text('unit'),
    estimatedPrice: bigint('estimated_price', { mode: 'number' }).notNull().default(0),
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull().default(0),
    supplierName: text('supplier_name'),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    ndsIncluded: boolean('nds_included').notNull().default(false),
    paymentType: text('payment_type'),
    sortOrder: integer('sort_order').notNull().default(0),
    // Per-item state machine (2026-07-11, multi-item + per-product actions):
    // pending | in_stock | out_of_stock | ordered | received | short | issued.
    status: text('status').notNull().default('pending'),
    // Actual quantity received at приёмка (#11) — may be < quantity (расхождение).
    receivedQty: numeric('received_qty').notNull().default('0'),
  },
  (t) => ({
    reqIdx: index('request_items_request_idx').on(t.requestId),
    requestSortIdx: index('request_items_request_sort_idx').on(t.requestId, t.sortOrder),
  }),
);

export const requestStatusHistory = pgTable(
  'request_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      // P1-8: RESTRICT, not cascade — business history (items, status history,
      // approvals, reservations, quotations, attachments) must never vanish when
      // a request row is deleted. Requests are archived, not hard-deleted.
      .references(() => requests.id, { onDelete: 'restrict' }),
    oldStatus: text('old_status'),
    newStatus: text('new_status').notNull(),
    changedBy: uuid('changed_by').references(() => users.id),
    comment: text('comment'),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ reqIdx: index('request_status_history_request_idx').on(t.requestId) }),
);

// ── Approvals & signatures ───────────────────────────────────────────────────
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      // P1-8: RESTRICT, not cascade — business history (items, status history,
      // approvals, reservations, quotations, attachments) must never vanish when
      // a request row is deleted. Requests are archived, not hard-deleted.
      .references(() => requests.id, { onDelete: 'restrict' }),
    workflowStepId: uuid('workflow_step_id').references(() => workflowSteps.id),
    approverUserId: uuid('approver_user_id').references(() => users.id),
    status: approvalStatus('status').notNull().default('pending'),
    comment: text('comment'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reqIdx: index('approvals_request_idx').on(t.requestId),
    // DB-enforced invariant: at most ONE pending approval per request at a time.
    // (This is the guard the legacy code only attempted in application logic.)
    onePending: uniqueIndex('approvals_one_pending_idx')
      .on(t.requestId)
      .where(sql`status = 'pending'`),
  }),
);

export const signatures = pgTable('signatures', {
  id: uuid('id').primaryKey().defaultRandom(),
  // P1-8: RESTRICT — a signature is legal evidence and must survive approval deletion.
  approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'restrict' }),
  requestId: uuid('request_id').references(() => requests.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  signatureType: signatureType('signature_type').notNull().default('telegram_pin'),
  signatureHash: text('signature_hash'),
  deviceInfo: text('device_info'),
  ipAddress: text('ip_address'),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Warehouse: balances + movement ledger + reservations ─────────────────────
// Rule (from the decisions doc): balances change ONLY via a movement, never by a
// silent edit. The service enforces this; the ledger is the source of truth.
export const movementType = pgEnum('movement_type', [
  'income',
  'outcome',
  'transfer',
  'adjustment',
  'reservation',
  'release',
  'write_off',
  'return',
  'correction',
]);
export const reservationStatus = pgEnum('reservation_status', [
  'active',
  'released',
  'consumed',
  'cancelled',
]);

export const stockBalances = pgTable(
  'stock_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    availableQty: numeric('available_qty').notNull().default('0'),
    reservedQty: numeric('reserved_qty').notNull().default('0'),
    minQty: numeric('min_qty').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // NOTE: uniqueness of (holding, material, COALESCE(warehouse)) is enforced by
  // the raw-SQL index stock_balances_uniq from migration 0009 (B8); the service
  // additionally recovers from its 23505 by re-reading the winner's row.
  (t) => ({ matIdx: index('stock_balances_material_idx').on(t.holdingId, t.materialId) }),
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    movementType: movementType('movement_type').notNull(),
    quantity: numeric('quantity').notNull(),
    requestId: uuid('request_id').references(() => requests.id),
    // Lifecycle step that produced this movement — part of the idempotency key
    // (a workflow may legitimately hold two receiving/issue steps). Null for
    // manual /warehouse operations.
    workflowStepId: uuid('workflow_step_id').references(() => workflowSteps.id),
    performedBy: uuid('performed_by').references(() => users.id),
    reason: text('reason'),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    matIdx: index('stock_movements_material_idx').on(t.materialId),
    createdIdx: index('stock_movements_created_idx').on(t.createdAt),
  }),
);

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  holdingId: uuid('holding_id')
    .notNull()
    .references(() => holdings.id),
  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'restrict' }),
  materialId: uuid('material_id')
    .notNull()
    .references(() => materials.id),
  warehouseId: uuid('warehouse_id').references(() => warehouses.id),
  quantity: numeric('quantity').notNull(),
  status: reservationStatus('status').notNull().default('active'),
  reservedBy: uuid('reserved_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Procurement: supplier quotations (КП) ────────────────────────────────────
export const quotations = pgTable(
  'quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    requestId: uuid('request_id')
      .notNull()
      // P1-8: RESTRICT, not cascade — business history (items, status history,
      // approvals, reservations, quotations, attachments) must never vanish when
      // a request row is deleted. Requests are archived, not hard-deleted.
      .references(() => requests.id, { onDelete: 'restrict' }),
    supplierName: text('supplier_name').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    amount: bigint('amount', { mode: 'number' }).notNull().default(0),
    ndsIncluded: boolean('nds_included').notNull().default(false),
    paymentType: text('payment_type'),
    leadTime: text('lead_time'),
    note: text('note'),
    selected: boolean('selected').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ reqIdx: index('quotations_request_idx').on(t.requestId) }),
);

// ── Suppliers (procurement) — normalized supplier directory, holding-scoped ──
export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    name: text('name').notNull(),
    inn: text('inn'),
    phone: text('phone'),
    normalizedPhone: text('normalized_phone'),
    email: text('email'),
    contactPerson: text('contact_person'),
    category: text('category'),
    rating: numeric('rating'),
    note: text('note'),
    status: entityStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    holdingIdx: index('suppliers_holding_idx').on(t.holdingId),
    phoneIdx: uniqueIndex('suppliers_holding_normalized_phone_idx').on(t.holdingId, t.normalizedPhone),
  }),
);

// ── Attachments (base64 stored in text; capped at the API boundary) ──────────
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id),
    requestId: uuid('request_id')
      .notNull()
      // P1-8: RESTRICT, not cascade — business history (items, status history,
      // approvals, reservations, quotations, attachments) must never vanish when
      // a request row is deleted. Requests are archived, not hard-deleted.
      .references(() => requests.id, { onDelete: 'restrict' }),
    uploaderId: uuid('uploader_id').references(() => users.id),
    filename: text('filename').notNull(),
    mime: text('mime'),
    size: integer('size').notNull().default(0),
    dataBase64: text('data_base64'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ reqIdx: index('attachments_request_idx').on(t.requestId) }),
);

// ── Notifications (P1-6) ─────────────────────────────────────────────────────
// Every critical notification is persisted BEFORE delivery, so a failed Telegram
// send is recorded (status='failed') and can be retried, never lost silently.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').references(() => holdings.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    message: text('message').notNull(),
    // low | normal | high | urgent | critical
    priority: text('priority').notNull().default('normal'),
    // dashboard | telegram | email | sms
    channel: text('channel').notNull().default('telegram'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    actionUrl: text('action_url'),
    actionButtons: jsonb('action_buttons'),
    // Тип события для тегов UI: step_pending | stage_passed | approved_final |
    // rejected | needs_revision | returned_step | closed | configuration |
    // security | null (legacy).
    kind: text('kind'),
    // pending | delivered | failed | read
    status: text('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    recipientIdx: index('notifications_recipient_idx').on(t.recipientUserId),
    statusIdx: index('notifications_status_idx').on(t.status),
  }),
);

// ── Rejection reasons (bug #3) ───────────────────────────────────────────────
// Configurable presets shown in the reject dialog. holding_id NULL = system
// default; role_code NULL = applies to any role. "Другое" is added by the UI.
export const rejectionReasons = pgTable(
  'rejection_reasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdingId: uuid('holding_id').references(() => holdings.id),
    roleCode: text('role_code'),
    text: text('text').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ roleIdx: index('rejection_reasons_role_idx').on(t.roleCode) }),
);
