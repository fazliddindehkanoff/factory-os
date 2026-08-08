import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { issueSession, verifySession } from '../auth/session.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';
import { createRequest } from '../services/request.service.js';
import { MONEY_PERMS } from './request-visibility.js';

type Db = any;

const TABLER_ASSET_ROOT = fileURLToPath(new URL('../../node_modules/@tabler/icons/', import.meta.url));
const TABLER_ICON_NAMES = [
  'alert-circle', 'alert-triangle', 'archive', 'arrow-down', 'arrow-up', 'bell', 'building', 'building-factory-2',
  'building-store', 'cash', 'chevron-down', 'columns-3', 'eye', 'file-description', 'file-spreadsheet', 'filter',
  'grip-vertical', 'id-badge-2', 'language', 'layout-dashboard', 'list-details', 'lock', 'logout', 'menu-2', 'moon', 'pencil',
  'plus', 'ruler-2', 'search', 'settings', 'shield-check', 'shield-lock', 'shopping-cart', 'sun', 'trash', 'truck-delivery',
  'user', 'users', 'x',
] as const;
const TABLER_ICON_SET = new Set<string>(TABLER_ICON_NAMES);
const TABLER_ICON_CSS = [
  '.ti::before{content:"";display:block;width:1em;height:1em;background:currentColor;mask:var(--ti-icon) center/contain no-repeat;-webkit-mask:var(--ti-icon) center/contain no-repeat}',
  ...TABLER_ICON_NAMES.map((name) => `.ti-${name}{--ti-icon:url("/snab-dashboard/assets/icons/${name}.svg")}`),
].join('');

interface DashboardActor {
  id: string;
  holdingId: string;
  username: string;
  fullName: string;
  permissions: string[];
  mustChangePassword: boolean;
}

interface DashboardRow {
  itemId: string;
  requestId: string;
  factoryId: string | null;
  month: string;
  date: string;
  object: string;
  warehouse: string;
  requester: string;
  requestNumber: string;
  expenseArticle: string;
  productType: string;
  productCode: string;
  materialName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  exchangeRate: number;
  amount: number;
  usdAmount: number;
  ndsRate: number;
  amountWithNds: number;
  usdAmountWithNds: number;
  paymentType: string;
  contractNumber: string;
  contractDate: string;
  supplier: string;
  person: string;
  contacts: string;
  cfoReceiver: string;
  productNote: string;
}

interface DashboardUpdate {
  object?: unknown;
  warehouse?: unknown;
  expenseArticle?: unknown;
  productType?: unknown;
  productCode?: unknown;
  materialName?: unknown;
  unit?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  ndsRate?: unknown;
  paymentType?: unknown;
  contractNumber?: unknown;
  contractDate?: unknown;
  supplier?: unknown;
  person?: unknown;
  contacts?: unknown;
  cfoReceiver?: unknown;
  productNote?: unknown;
}

const HEADERS = [
  'Месяц',
  'Дата',
  'Объект',
  'Склад',
  'Заявитель',
  'Номер заявки',
  'Статья расходов',
  'Тип товара',
  'Код товара',
  'Наименования материалов',
  'Ед.изм',
  'Количество (Куплено)',
  'Цена за единицу',
  'Курс Валют',
  'Сумма',
  'USD Сумма',
  'Ставка НДС %',
  'Сумма с НДС',
  'USD Сумма с НДС',
  'Тип платежа (ПЕР/НАЛ)',
  'Номер договора',
  'Дата договора',
  'Поставщик',
  'Лицо',
  'Контакты',
  'Получатель_ЦФО',
  'Примечание для Товара',
] as const;

const GROUPS: Array<[string, number]> = [
  ['ДАТА', 2],
  ['АДРЕСАТ', 4],
  ['ТОВАР', 6],
  ['ФИНАНСЫ', 8],
  ['ПОСТАВЩИК', 5],
  ['ОТВЕТСТВЕННЫЙ', 2],
];

const KEYS: Array<keyof DashboardRow> = [
  'month',
  'date',
  'object',
  'warehouse',
  'requester',
  'requestNumber',
  'expenseArticle',
  'productType',
  'productCode',
  'materialName',
  'unit',
  'quantity',
  'unitPrice',
  'exchangeRate',
  'amount',
  'usdAmount',
  'ndsRate',
  'amountWithNds',
  'usdAmountWithNds',
  'paymentType',
  'contractNumber',
  'contractDate',
  'supplier',
  'person',
  'contacts',
  'cfoReceiver',
  'productNote',
];

const EDITABLE_KEYS = new Set<keyof DashboardRow>([
  'object',
  'warehouse',
  'expenseArticle',
  'productType',
  'productCode',
  'materialName',
  'unit',
  'quantity',
  'unitPrice',
  'ndsRate',
  'paymentType',
  'contractNumber',
  'contractDate',
  'supplier',
  'person',
  'contacts',
  'cfoReceiver',
  'productNote',
]);

function dashboardCredentials(): { username: string; password: string } {
  return {
    username: process.env.SNAB_DASHBOARD_USERNAME?.trim() ?? '',
    password: process.env.SNAB_DASHBOARD_PASSWORD ?? '',
  };
}

function timingSafeTextEqual(raw: unknown, expected: string): boolean {
  if (!expected || typeof raw !== 'string') return false;
  const a = Buffer.from(raw, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(username: unknown, password: unknown): boolean {
  const expected = dashboardCredentials();
  return timingSafeTextEqual(username, expected.username) && timingSafeTextEqual(password, expected.password);
}

function normalizeUsername(value: unknown): string {
  return text(value).trim().toLowerCase();
}

function validUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(username);
}

async function findDashboardUser(db: Db, username: string): Promise<any | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = ${username}`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One-time bridge from the old deployment credential to a real user account.
 * It is deliberately disabled as soon as any dashboard username exists. The
 * first matching login is attached to the oldest active owner/admin account,
 * keeping the Telegram identity, audit history, and RBAC assignments intact.
 */
async function bootstrapDashboardUser(
  db: Db,
  username: string,
  password: string,
  sessionSecret: string,
): Promise<any | null> {
  if (!isAuthorized(username, password)) return null;
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(isNotNull(schema.users.username)).limit(1);
  if (existing.length) return null;

  const result = await db.execute(sql`
    SELECT u.id
    FROM users u
    INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.status = 'active'
    INNER JOIN roles r ON r.id = ur.role_id
    WHERE u.status = 'active'
      AND u.holding_id IS NOT NULL
      AND r.code IN ('owner', 'admin')
    ORDER BY CASE WHEN r.code = 'owner' THEN 0 ELSE 1 END, ur.assigned_at ASC
    LIMIT 1
  `);
  const candidates: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const userId = text(candidates[0]?.id);
  if (!userId) return null;

  const [updated] = await db
    .update(schema.users)
    .set({ username, passwordHash: hashPassword(password, sessionSecret), updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
    .returning();
  return updated ?? null;
}

async function authenticateDashboardUser(
  db: Db,
  usernameRaw: unknown,
  passwordRaw: unknown,
  sessionSecret: string,
): Promise<any | null> {
  const username = normalizeUsername(usernameRaw);
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';
  if (!validUsername(username) || !password) return null;

  let user = await findDashboardUser(db, username);
  if (!user) user = await bootstrapDashboardUser(db, username, password, sessionSecret);
  if (!user || user.status !== 'active' || !user.holdingId) return null;
  return verifyPassword(password, user.passwordHash, sessionSecret) ? user : null;
}

async function dashboardActor(db: Db, req: Request, sessionSecret: string): Promise<DashboardActor | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifySession(token, sessionSecret) : null;
  if (!payload) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, payload.uid));
  if (!user || user.status !== 'active' || !user.holdingId || !user.username) return null;
  return {
    id: user.id,
    holdingId: user.holdingId,
    username: user.username,
    fullName: user.fullName,
    permissions: await getUserPermissionCodes(db, user.id),
    mustChangePassword: !!user.mustChangePassword,
  };
}

function canAny(actor: DashboardActor, codes: string[]): boolean {
  return codes.some((code) => actor.permissions.includes(code));
}

async function requireDashboardActor(
  db: Db,
  req: Request,
  res: Response,
  sessionSecret: string,
  permissionCodes: string[] = [],
): Promise<DashboardActor | null> {
  const actor = await dashboardActor(db, req, sessionSecret);
  if (!actor) {
    res.status(401).json({ error: 'Сессия истекла — войдите снова' });
    return null;
  }
  if (permissionCodes.length && !canAny(actor, permissionCodes)) {
    res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    return null;
  }
  return actor;
}

function dateOnly(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function monthLabel(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(d);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function text(v: unknown): string {
  return v == null ? '' : String(v);
}

interface DashboardMaterial {
  id: string;
  code: string;
  title: string;
  titleUz: string;
  titleTr: string;
  unit: string;
}

// The client picks the language at render time (see localized() there) — but a
// snapshot written into a request item's name is baked in once, at write time,
// so *that* path needs the viewer's language passed in explicitly (see the
// `lang` body field on the row-edit and create-request routes below).
function titleFor(m: DashboardMaterial, lang: unknown): string {
  const l = text(lang);
  if (l === 'uz' && m.titleUz) return m.titleUz;
  if (l === 'tr' && m.titleTr) return m.titleTr;
  return m.title;
}

async function fetchDashboardMaterials(db: Db, holdingId: string): Promise<DashboardMaterial[]> {
  const result = await db.execute(sql`
    SELECT id, sku, name, name_uz, name_tr, default_unit
    FROM materials
    WHERE holding_id = ${holdingId}
      AND status = 'active'
    ORDER BY name ASC
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.map((row) => ({
    id: text(row.id),
    code: text(row.sku).trim(),
    title: text(row.name).trim(),
    titleUz: text(row.name_uz).trim(),
    titleTr: text(row.name_tr).trim(),
    unit: text(row.default_unit).trim(),
  }));
}

async function materialByCode(db: Db, holdingId: string, rawCode: unknown): Promise<DashboardMaterial | null> {
  const code = text(rawCode).trim();
  if (!code) return null;
  const result = await db.execute(sql`
    SELECT id, sku, name, name_uz, name_tr, default_unit
    FROM materials
    WHERE holding_id = ${holdingId}
      AND status = 'active'
      AND lower(btrim(sku)) = lower(${code})
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const row = rows[0];
  return row ? {
    id: text(row.id),
    code: text(row.sku).trim(),
    title: text(row.name).trim(),
    titleUz: text(row.name_uz).trim(),
    titleTr: text(row.name_tr).trim(),
    unit: text(row.default_unit).trim(),
  } : null;
}

async function materialByTitle(db: Db, holdingId: string, rawTitle: unknown): Promise<DashboardMaterial | null> {
  const title = text(rawTitle).trim();
  if (!title) return null;
  const result = await db.execute(sql`
    SELECT id, sku, name, name_uz, name_tr, default_unit
    FROM materials
    WHERE holding_id = ${holdingId}
      AND status = 'active'
      AND (
        lower(btrim(name)) = lower(${title})
        OR lower(btrim(COALESCE(name_uz, ''))) = lower(${title})
        OR lower(btrim(COALESCE(name_tr, ''))) = lower(${title})
      )
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const row = rows[0];
  return row ? {
    id: text(row.id),
    code: text(row.sku).trim(),
    title: text(row.name).trim(),
    titleUz: text(row.name_uz).trim(),
    titleTr: text(row.name_tr).trim(),
    unit: text(row.default_unit).trim(),
  } : null;
}

function parseJsonObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseDescription(description: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text(description).split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function buildDescription(row: DashboardUpdate): string {
  const lines: string[] = [];
  const productCode = text(row.productCode).trim();
  const warehouse = text(row.warehouse).trim();
  const expenseArticle = text(row.expenseArticle).trim();
  const productType = text(row.productType).trim();
  const productNote = text(row.productNote).trim();
  if (productCode) lines.push(`Код товара: ${productCode}`);
  if (warehouse) lines.push(`Склад назначения: ${warehouse}`);
  if (expenseArticle) lines.push(`Назначение / цель: ${expenseArticle}`);
  if (productType) lines.push(`Тип товара: ${productType}`);
  if (productNote) lines.push(`Примечание: ${productNote}`);
  return lines.join('\n');
}

function normalizeUpdate(input: unknown): DashboardUpdate {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    object: text(raw.object).trim(),
    warehouse: text(raw.warehouse).trim(),
    expenseArticle: text(raw.expenseArticle).trim(),
    productType: text(raw.productType).trim(),
    productCode: text(raw.productCode).trim(),
    materialName: text(raw.materialName).trim(),
    unit: text(raw.unit).trim(),
    quantity: num(raw.quantity),
    unitPrice: num(raw.unitPrice),
    ndsRate: num(raw.ndsRate),
    paymentType: text(raw.paymentType).trim(),
    contractNumber: text(raw.contractNumber).trim(),
    contractDate: text(raw.contractDate).trim(),
    supplier: text(raw.supplier).trim(),
    person: text(raw.person).trim(),
    contacts: text(raw.contacts).trim(),
    cfoReceiver: text(raw.cfoReceiver).trim(),
    productNote: text(raw.productNote).trim(),
  };
}

async function refreshRequestAmount(db: Db, requestId: string): Promise<void> {
  await db.execute(sql`
    UPDATE requests
    SET estimated_amount = COALESCE((
      SELECT SUM(total_amount)::bigint
      FROM request_items
      WHERE request_id = ${requestId}
    ), 0),
    updated_at = now()
    WHERE id = ${requestId}
  `);
}

/**
 * Branches (factories) a user can switch between in the topbar: the union of
 * factories linked (via department_factories) to any otdel the user belongs to
 * (user_departments), plus each such otdel's legacy single `factoryId` as a
 * fallback for otdels not yet given an explicit multi-assignment. Empty result
 * means "unrestricted" — the switcher stays disabled and every branch is shown.
 */
async function fetchUserBranches(db: Db, userId: string, holdingId: string): Promise<{ id: string; name: string }[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT f.id, f.name
    FROM user_departments ud
    JOIN departments d ON d.id = ud.department_id
    LEFT JOIN department_factories df ON df.department_id = d.id
    JOIN factories f ON f.id = COALESCE(df.factory_id, d.factory_id)
    WHERE ud.user_id = ${userId} AND f.holding_id = ${holdingId}
    ORDER BY f.name
  `);
  const rows: Array<{ id: string; name: string }> = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.map((r) => ({ id: text(r.id), name: text(r.name) }));
}

async function fetchDashboardRows(db: Db, holdingId: string, options: { requesterId?: string; viewAll?: boolean } = {}): Promise<DashboardRow[]> {
  const visibilityWhere = options.viewAll
    ? sql``
    : sql`AND r.requester_id = ${options.requesterId ?? ''}`;
  const result = await db.execute(sql`
    SELECT
      r.created_at,
      r.id AS request_id,
      r.request_number,
      r.warehouse_name,
      r.factory_id,
      r.custom_fields,
      requester.full_name AS requester_name,
      ri.id AS item_id,
      ri.name AS item_name,
      ri.description AS item_description,
      ri.quantity,
      ri.unit,
      ri.estimated_price,
      ri.total_amount,
      ri.supplier_name AS item_supplier_name,
      ri.nds_included AS item_nds_included,
      ri.payment_type AS item_payment_type,
      q.supplier_name AS quote_supplier_name,
      q.payment_type AS quote_payment_type,
      q.lead_time AS quote_lead_time
    FROM request_items ri
    INNER JOIN requests r ON r.id = ri.request_id
    LEFT JOIN users requester ON requester.id = r.requester_id
    LEFT JOIN LATERAL (
      SELECT supplier_name, payment_type, lead_time
      FROM quotations
      WHERE quotations.request_id = r.id
      ORDER BY selected DESC, created_at DESC
      LIMIT 1
    ) q ON TRUE
    WHERE r.holding_id = ${holdingId}
      AND r.status <> 'deleted'
      ${visibilityWhere}
    ORDER BY r.created_at DESC, r.request_number DESC, ri.sort_order ASC, ri.id ASC
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);

  return rows.map((r) => {
    const cf = parseJsonObject(r.custom_fields);
    const desc = parseDescription(r.item_description);
    const amount = num(r.total_amount);
    const ndsRate = r.item_nds_included ? 12 : 0;
    return {
      month: monthLabel(r.created_at),
      itemId: text(r.item_id),
      requestId: text(r.request_id),
      factoryId: text(r.factory_id) || null,
      date: dateOnly(r.created_at),
      object: text(cf.obyekt || cf.object),
      warehouse: text(desc['склад назначения'] || r.warehouse_name),
      requester: text(r.requester_name),
      requestNumber: text(r.request_number),
      expenseArticle: text(desc['назначение / цель'] || cf.purpose),
      productType: text(desc['тип товара'] || cf.origin),
      productCode: text(desc['код товара']),
      materialName: text(r.item_name),
      unit: text(r.unit),
      quantity: num(r.quantity),
      unitPrice: num(r.estimated_price),
      exchangeRate: 1,
      amount,
      usdAmount: 0,
      ndsRate,
      amountWithNds: amount,
      usdAmountWithNds: 0,
      paymentType: text(r.item_payment_type || r.quote_payment_type),
      contractNumber: text(cf.dashboard_contract_number),
      contractDate: text(cf.dashboard_contract_date),
      supplier: text(r.item_supplier_name || r.quote_supplier_name),
      person: text(cf.dashboard_supplier_person),
      contacts: text(cf.dashboard_supplier_contacts),
      cfoReceiver: text(cf.dashboard_cfo_receiver || r.requester_name),
      productNote: text(desc['примечание'] || r.quote_lead_time),
    };
  });
}

async function updateDashboardRow(db: Db, holdingId: string, itemId: string, patch: unknown, lang: unknown): Promise<void> {
  const row = normalizeUpdate(patch);
  const catalogMaterial = await materialByCode(db, holdingId, row.productCode);
  if (catalogMaterial) {
    row.productCode = catalogMaterial.code;
    row.materialName = titleFor(catalogMaterial, lang);
    if (catalogMaterial.unit) row.unit = catalogMaterial.unit;
  }
  const quantity = num(row.quantity);
  const unitPrice = num(row.unitPrice);
  const totalAmount = Math.round(quantity * unitPrice);
  const ndsIncluded = num(row.ndsRate) > 0;
  const customFields = {
    obyekt: text(row.object),
    object: text(row.object),
    dashboard_contract_number: text(row.contractNumber),
    dashboard_contract_date: text(row.contractDate),
    dashboard_supplier_person: text(row.person),
    dashboard_supplier_contacts: text(row.contacts),
    dashboard_cfo_receiver: text(row.cfoReceiver),
  };

  const result = await db.execute(sql`
    UPDATE request_items ri
    SET
      name = COALESCE(NULLIF(${text(row.materialName)}, ''), ri.name),
      description = ${buildDescription(row)},
      quantity = ${String(quantity)},
      unit = NULLIF(${text(row.unit)}, ''),
      estimated_price = ${unitPrice},
      total_amount = ${totalAmount},
      supplier_name = NULLIF(${text(row.supplier)}, ''),
      nds_included = ${ndsIncluded},
      payment_type = NULLIF(${text(row.paymentType)}, '')
    FROM requests r
    WHERE ri.id = ${itemId}
      AND r.id = ri.request_id
      AND r.holding_id = ${holdingId}
    RETURNING ri.request_id AS request_id
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const requestId = text(rows[0]?.request_id);
  if (!requestId) throw new Error('Dashboard row not found');

  await db.execute(sql`
    UPDATE requests
    SET
      warehouse_name = NULLIF(${text(row.warehouse)}, ''),
      custom_fields = COALESCE(custom_fields, '{}'::jsonb) || ${JSON.stringify(customFields)}::jsonb,
      updated_at = now()
    WHERE id = ${requestId}
  `);
  await refreshRequestAmount(db, requestId);
}

async function deleteDashboardRow(db: Db, holdingId: string, itemId: string): Promise<void> {
  const result = await db.execute(sql`
    DELETE FROM request_items ri
    USING requests r
    WHERE ri.id = ${itemId}
      AND r.id = ri.request_id
      AND r.holding_id = ${holdingId}
    RETURNING ri.request_id
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const requestId = text(rows[0]?.request_id);
  if (!requestId) throw new Error('Dashboard row not found');
  await refreshRequestAmount(db, requestId);
}

// ── Meta + create (the «Новая заявка» view of the dashboard) ─────────────────

function optionList(v: unknown): { value: string; label: string }[] {
  const raw = Array.isArray(v) ? v : [];
  return raw
    .map((o) => ({ value: text((o as any)?.value), label: text((o as any)?.label) || text((o as any)?.value) }))
    .filter((o) => o.value);
}

async function fetchCreateMeta(db: Db, holdingId: string, userId?: string): Promise<Record<string, unknown>> {
  const usersRes = await db.execute(sql`
    SELECT id, full_name FROM users
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY full_name ASC
  `);
  const deptRes = await db.execute(sql`
    SELECT id, name, name_uz, name_tr FROM departments
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY name ASC
  `);
  const userDeptRes = await db.execute(sql`
    SELECT ud.user_id, d.id AS department_id, d.name, d.name_uz, d.name_tr
    FROM user_departments ud
    JOIN departments d ON d.id = ud.department_id
    JOIN users u ON u.id = ud.user_id
    WHERE u.holding_id = ${holdingId} AND u.status = 'active' AND d.status = 'active'
    UNION
    SELECT ur.user_id, d.id AS department_id, d.name, d.name_uz, d.name_tr
    FROM user_roles ur
    JOIN departments d ON d.id = ur.department_id
    JOIN users u ON u.id = ur.user_id
    WHERE u.holding_id = ${holdingId} AND u.status = 'active' AND ur.status = 'active' AND d.status = 'active'
  `);
  const whRes = await db.execute(sql`
    SELECT name, name_uz, name_tr FROM warehouses
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY name ASC
  `);
  const unitRes = await db.execute(sql`
    SELECT code, name_ru, name_uz, name_tr
    FROM unit_types
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY order_index ASC, name_ru ASC
  `);
  const ffRes = await db.execute(sql`
    SELECT field_key, options FROM form_fields
    WHERE holding_id = ${holdingId} AND screen = 'request_create' AND enabled = true
  `);
  const allDepartments = (Array.isArray(deptRes) ? deptRes : deptRes.rows ?? [])
    .map((d: any) => ({ id: text(d.id), name: text(d.name), nameUz: text(d.name_uz), nameTr: text(d.name_tr) }));
  const departmentsByUser = new Map<string, { id: string; name: string; nameUz: string; nameTr: string }[]>();
  for (const row of (Array.isArray(userDeptRes) ? userDeptRes : userDeptRes.rows ?? []) as any[]) {
    const ownerId = text(row.user_id);
    const department = { id: text(row.department_id), name: text(row.name), nameUz: text(row.name_uz), nameTr: text(row.name_tr) };
    const current = departmentsByUser.get(ownerId) ?? [];
    if (!current.some((item) => item.id === department.id)) departmentsByUser.set(ownerId, [...current, department]);
  }
  const users = (Array.isArray(usersRes) ? usersRes : usersRes.rows ?? []).map((u: any) => ({
    id: text(u.id),
    name: text(u.full_name),
    departments: departmentsByUser.get(text(u.id)) ?? [],
  }));
  const actorDepartmentIds = userId ? new Set((departmentsByUser.get(userId) ?? []).map((d) => d.id)) : new Set<string>();
  // An assigned requester starts with their configured otdels; an unconfigured
  // requester still sees the complete list so the form never dead-ends.
  const departments = actorDepartmentIds.size > 0
    ? allDepartments.filter((d: { id: string }) => actorDepartmentIds.has(d.id))
    : allDepartments;
  // Downstream storage (requests.warehouseName) is free text keyed by the RU
  // name, so `name` stays the stable value — only the select's visible label
  // is localized client-side.
  const warehouses = (Array.isArray(whRes) ? whRes : whRes.rows ?? [])
    .map((w: any) => ({ name: text(w.name), nameUz: text(w.name_uz), nameTr: text(w.name_tr) }));
  const units = (Array.isArray(unitRes) ? unitRes : unitRes.rows ?? [])
    .map((u: any) => ({ value: text(u.name_ru), label: text(u.name_ru), name: text(u.name_ru), nameUz: text(u.name_uz), nameTr: text(u.name_tr), code: text(u.code) }))
    .filter((u: { value: string }) => u.value);
  const ff = new Map<string, unknown>();
  for (const f of (Array.isArray(ffRes) ? ffRes : ffRes.rows ?? []) as any[]) ff.set(text(f.field_key), f.options);

  return {
    holdingId,
    materials: await fetchDashboardMaterials(db, holdingId),
    users,
    departments,
    warehouses,
    types: optionList(ff.get('requestType')).length ? optionList(ff.get('requestType')) : [
      { value: 'material_request', label: 'Материал' },
      { value: 'service_request', label: 'Услуга' },
    ],
    objects: optionList(ff.get('obyekt')),
    purposes: optionList(ff.get('purpose')),
    origins: optionList(ff.get('origin')).length ? optionList(ff.get('origin')) : [
      { value: 'local', label: 'Местный' },
      { value: 'import', label: 'Импорт' },
    ],
    units,
    priorities: optionList(ff.get('priority')).length ? optionList(ff.get('priority')) : [
      { value: 'normal', label: 'Стандартная' },
      { value: 'high', label: 'Срочная' },
      { value: 'urgent', label: 'Аварийная' },
    ],
  };
}

interface CreateBody {
  requesterId?: unknown;
  requestType?: unknown;
  departmentId?: unknown;
  warehouseName?: unknown;
  warehouseId?: unknown;
  lang?: unknown;
  obyekt?: unknown;
  origin?: unknown;
  purpose?: unknown;
  priority?: unknown;
  neededDate?: unknown;
  comment?: unknown;
  items?: unknown;
}

async function createFromDashboard(db: Db, holdingId: string, body: CreateBody): Promise<{ id: string; requestNumber: string }> {
  const requesterId = text(body.requesterId).trim();
  if (!requesterId) throw new Error('Укажите заявителя');
  const requesterCheck = await db.execute(sql`
    SELECT id FROM users
    WHERE id = ${requesterId} AND holding_id = ${holdingId} AND status = 'active'
    LIMIT 1
  `);
  const requesters: Array<Record<string, unknown>> = Array.isArray(requesterCheck) ? requesterCheck : (requesterCheck.rows ?? []);
  if (!requesters.length) throw new Error('Заявитель не найден в вашей организации');

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map((it: any) => ({
      name: text(it?.name).trim(),
      code: text(it?.code).trim(),
      qty: num(it?.qty),
      unit: text(it?.unit).trim(),
      price: num(it?.price),
      pay: text(it?.pay).trim(),
      nds: it?.nds === true || text(it?.nds).toLowerCase() === 'true',
      note: text(it?.note).trim(),
    }))
    .filter((it) => it.name);
  for (const item of items) {
    const catalogMaterial = (await materialByCode(db, holdingId, item.code))
      ?? (await materialByTitle(db, holdingId, item.name));
    if (!catalogMaterial) continue;
    (item as any).materialId = catalogMaterial.id;
    item.code = catalogMaterial.code;
    item.name = titleFor(catalogMaterial, body.lang);
    if (catalogMaterial.unit) item.unit = catalogMaterial.unit;
  }
  if (!items.length) throw new Error('Добавьте хотя бы одну позицию');
  for (const it of items) if (!(it.qty > 0)) throw new Error('Количество должно быть больше нуля: ' + it.name);

  const priority = ['low', 'normal', 'high', 'urgent', 'critical'].includes(text(body.priority)) ? text(body.priority) as any : 'normal';
  const customFields: Record<string, unknown> = {};
  if (text(body.obyekt).trim()) { customFields.obyekt = text(body.obyekt).trim(); customFields.object = text(body.obyekt).trim(); }
  if (text(body.origin).trim()) customFields.origin = text(body.origin).trim();
  if (text(body.purpose).trim()) customFields.purpose = text(body.purpose).trim();
  const neededRaw = text(body.neededDate).trim();
  const neededDate = neededRaw ? new Date(neededRaw) : null;

  const req = await createRequest(db, {
    holdingId,
    requesterId,
    departmentId: text(body.departmentId).trim() || null,
    requestType: text(body.requestType).trim() || 'material_request',
    priority,
    title: items[0].name,
    description: text(body.comment).trim() || undefined,
    warehouseId: text(body.warehouseId).trim() || null,
    warehouseName: text(body.warehouseName).trim() || null,
    neededDate: neededDate && !Number.isNaN(neededDate.getTime()) ? neededDate : null,
    customFields: Object.keys(customFields).length ? customFields : null,
    items: items.map((it) => {
      // Description keys mirror what fetchDashboardRows parses back into columns.
      const lines: string[] = [];
      if (it.code) lines.push(`Код товара: ${it.code}`);
      if (it.note) lines.push(`Примечание: ${it.note}`);
      return {
        name: it.name,
        materialId: (it as any).materialId ?? null,
        quantity: it.qty,
        unitPrice: it.price,
        unit: it.unit || null,
        paymentType: it.pay || null,
        ndsIncluded: it.nds,
        description: lines.length ? lines.join('\n') : null,
      };
    }),
  });

  return { id: text(req.id), requestNumber: text(req.requestNumber) };
}

// ── Page ─────────────────────────────────────────────────────────────────────
// Design language ported from the confirmed «Новая заявка» mock: dark #080D19,
// indigo→cyan gradient accents, Inter. Sidebar is NAVIGATION ONLY (Обзор /
// Новая заявка / Выйти) — filters live in a collapsible panel above the table.

function pageHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Снабжение — Dashboard</title>
  <link rel="stylesheet" href="/snab-dashboard/assets/tabler-icons.min.css" />
  <style>
    :root{
      --bg:#0B111D;--bg-elev:#121A29;--card:#162132;--card-hover:#1C293D;
      --border:#29364A;--border-strong:#40506A;--text:#F3F6FA;--text-sec:#B2BDCC;--text-muted:#7E8A9C;
      --accent1:#2F6FED;--accent2:#2F6FED;--ring:rgba(47,111,237,.28);
      --green:#35B979;--green-bg:rgba(53,185,121,.12);--green-bd:rgba(53,185,121,.34);
      --amber:#E7A330;--amber-bg:rgba(231,163,48,.12);--amber-bd:rgba(231,163,48,.34);
      --red:#EF6A62;--red-bg:rgba(239,106,98,.12);--red-bd:rgba(239,106,98,.34);
      --overlay:rgba(3,7,18,.68);--shadow:0 18px 44px rgba(0,0,0,.34);
      --radius-card:12px;--radius-ctl:8px;color-scheme:dark;
      /* Text sitting on a low-opacity accent-tinted chip/badge background. */
      --accent-soft-text:#C7D2FE;
      /* Subtle "raise this surface" tint — lightens on dark, darkens on light. */
      --veil:rgba(255,255,255,.035);
    }
    body[data-theme="light"]{
      --bg:#F4F6F9;--bg-elev:#FFFFFF;--card:#FFFFFF;--card-hover:#F7F9FC;
      --border:#E1E6EE;--border-strong:#C8D0DC;--text:#172033;--text-sec:#536075;--text-muted:#7B8799;
      --accent1:#245FC7;--accent2:#245FC7;--ring:rgba(36,95,199,.18);
      --green:#147A4D;--green-bg:#EAF8F0;--green-bd:#AADCC1;
      --amber:#9A5B0B;--amber-bg:#FFF5DF;--amber-bd:#EECF91;
      --red:#B53B34;--red-bg:#FDECEA;--red-bd:#EAB5B1;
      --overlay:rgba(15,23,42,.48);--shadow:0 18px 44px rgba(28,39,58,.16);color-scheme:light;
      --accent-soft-text:#3730A3;
      --veil:rgba(15,23,42,.035);
    }
    *{box-sizing:border-box;}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;}
    input,select,textarea,button{font:inherit;color:inherit;}
    .app-shell{min-height:100vh;display:grid;grid-template-columns:232px minmax(0,1fr);}
    /* ── login: procurement operations console ── */
    .login{min-height:100vh;display:grid;place-items:center;padding:28px;background:
      radial-gradient(circle at 18% 18%,rgba(99,102,241,.16),transparent 34%),
      radial-gradient(circle at 86% 82%,rgba(34,211,238,.10),transparent 31%),var(--bg);}
    .login-shell{width:min(980px,100%);min-height:590px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(360px,.92fr);overflow:hidden;border:1px solid var(--border);border-radius:24px;background:#0A0F1D;box-shadow:0 32px 80px rgba(0,0,0,.38);}
    .login-story{position:relative;overflow:hidden;padding:46px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(145deg,rgba(99,102,241,.17),rgba(10,15,29,.15) 48%),#0D1425;}
    .login-story:before{content:'';position:absolute;inset:0;opacity:.18;background-image:linear-gradient(rgba(148,163,184,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.16) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,black,transparent 78%);pointer-events:none;}
    .login-brand,.login-story-copy,.flow-line{position:relative;z-index:1;}
    .login-brand{display:flex;align-items:center;gap:12px;font-weight:700;letter-spacing:.08em;font-size:12px;}
    .login-brand-mark{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(135deg,var(--accent1),var(--accent2));box-shadow:0 8px 24px rgba(34,211,238,.18);}
    .login-story h1{max-width:500px;margin:0 0 14px;font-size:clamp(32px,4vw,48px);line-height:1.05;letter-spacing:-.045em;font-weight:600;}
    .login-story p{max-width:440px;margin:0;color:var(--text-sec);font-size:14px;line-height:1.7;}
    .flow-line{display:grid;grid-template-columns:auto 1fr auto 1fr auto;align-items:center;gap:10px;color:var(--text-muted);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}
    .flow-node{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:9px;background:rgba(255,255,255,.04);color:#C7D2FE;}
    .flow-link{height:1px;background:linear-gradient(90deg,rgba(99,102,241,.75),rgba(34,211,238,.32));}
    .login-panel{display:flex;align-items:center;padding:46px;background:rgba(8,13,25,.78);}
    .login-card{width:100%;max-width:380px;margin:auto;}
    .login-kicker{margin-bottom:10px;color:#A5B4FC;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;}
    .login-card h2{margin:0;font-size:26px;letter-spacing:-.025em;}
    .login-card .sub{color:var(--text-sec);margin:7px 0 28px;font-size:13px;line-height:1.6;}
    .login-field{margin-bottom:16px;}
    .login-field label{display:block;margin:0 0 7px;color:#CBD5E1;font-size:12px;font-weight:600;}
    .login-input-wrap{position:relative;}
    .login-input-icon{position:absolute;left:13px;top:50%;translate:0 -50%;display:grid;place-items:center;color:var(--text-muted);pointer-events:none;}
    .login-input{width:100%;height:46px;background:rgba(255,255,255,.035);border:1px solid var(--border);border-radius:var(--radius-ctl);padding:0 44px 0 42px;outline:none;transition:border-color .14s,box-shadow .14s,background .14s;}
    .login-input:hover{background:rgba(255,255,255,.05);}
    .login-input:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);background:rgba(255,255,255,.055);}
    .login-input::placeholder{color:#526078;}
    .eye{position:absolute;right:6px;top:6px;width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:var(--text-sec);display:grid;place-items:center;cursor:pointer;}
    .eye:hover{background:rgba(255,255,255,.07);color:var(--text);}
    .login-submit{width:100%;height:46px;margin-top:2px;}
    .login-submit:disabled{cursor:wait;filter:saturate(.6);opacity:.72;}
    .login-note{display:flex;align-items:flex-start;gap:8px;margin-top:18px;color:var(--text-muted);font-size:11.5px;line-height:1.5;}
    .login-note svg{flex:none;margin-top:1px;}
    .btn{border:0;border-radius:11px;padding:11px 17px;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;font-weight:600;font-size:13.5px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;transition:filter .12s;}
    .btn:hover{filter:brightness(1.1);}
    .btn.secondary{background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);}
    .btn.secondary:hover{background:rgba(255,255,255,0.09);}
    .btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text-sec);}
    .btn.ghost:hover{background:var(--card-hover);color:var(--text);}
    /* ── sidebar: navigation only ── */
    .sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:var(--bg-elev);border-right:1px solid var(--border);padding:16px 12px 12px;display:flex;flex-direction:column;}
    .side-brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:15px;letter-spacing:-.01em;padding:4px 6px 16px;border-bottom:1px solid var(--border);margin-bottom:10px;}
    .brand-dot{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--accent1),var(--accent2));flex:none;display:grid;place-items:center;color:#fff;font-weight:800;}
    .side-caption{color:var(--text-muted);font-size:11px;font-weight:500;margin-top:1px;}
    .side-cta{width:100%;margin-bottom:6px;}
    .nav-sec{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);padding:16px 10px 6px;}
    .nav-sec-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;border:0;background:transparent;cursor:pointer;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);padding:16px 10px 6px;}
    .nav-sec-toggle .ti{width:13px;height:13px;transition:transform .15s;}
    .nav-sec-toggle[aria-expanded="true"] .ti{transform:rotate(180deg);}
    .settings-group{display:flex;flex-direction:column;overflow:hidden;}
    .settings-group.collapsed{display:none;}
    .side-link{display:flex;align-items:center;justify-content:space-between;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:10px;background:none;color:var(--text-sec);font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background .12s,color .12s;}
    .side-label{display:flex;align-items:center;gap:9px;min-width:0;}
    .side-link:hover{background:rgba(255,255,255,0.05);color:var(--text);}
    .side-link.active{background:rgba(99,102,241,0.15);color:var(--accent-soft-text);font-weight:600;}
    .side-link svg{flex:0 0 auto;}
    .side-badge{min-width:18px;height:18px;padding:0 6px;border-radius:99px;background:var(--amber);color:#fff;font-size:10px;font-weight:800;line-height:18px;text-align:center;}
    .module-preview-btn{opacity:.82;}
    .module-preview-btn:hover{opacity:1;}
    .side-bottom{margin-top:auto;border-top:1px solid var(--border);padding-top:12px;}
    .side-user{display:flex;align-items:center;gap:9px;margin:0 5px 10px;padding:8px 5px;min-width:0;}
    .side-avatar{width:30px;height:30px;display:grid;place-items:center;flex:none;border-radius:9px;background:rgba(99,102,241,.18);color:var(--accent-soft-text);font-size:11px;font-weight:700;}
    .side-user-name{overflow:hidden;color:var(--text);font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;}
    .side-user-login{overflow:hidden;color:var(--text-muted);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap;}
    /* ── main ── */
    .main-pane{min-width:0;display:flex;flex-direction:column;}
    .navbar{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:14px;min-height:64px;padding:10px 20px;background:color-mix(in srgb,var(--bg) 92%,transparent);border-bottom:1px solid var(--border);backdrop-filter:blur(8px);}
    .nav-left{display:flex;align-items:center;gap:12px;min-width:0;}
    .menu-btn{display:none;width:42px;height:42px;border:1px solid var(--border);border-radius:11px;background:transparent;color:var(--text-sec);cursor:pointer;}
    .brand-title{font-size:15px;font-weight:600;line-height:1.15;}
    .brand-sub{color:var(--text-muted);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw;}
    .nav-actions{display:flex;align-items:center;gap:10px;min-width:0;}
    .search-wrap{display:flex;align-items:center;gap:9px;width:min(460px,34vw);background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:11px;padding:0 12px;}
    .search{width:100%;background:transparent;border:0;padding:10px 0;outline:none;}
    .search::placeholder{color:var(--text-muted);}
    .search-wrap:focus-within{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    .topbar-control,.icon-btn{height:38px;border:1px solid var(--border);border-radius:10px;background:var(--veil);color:var(--text-sec);display:inline-flex;align-items:center;gap:7px;padding:0 11px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
    .topbar-control:hover,.icon-btn:hover{background:var(--card-hover);color:var(--text);}
    .topbar-control.disabled,.topbar-control:disabled{cursor:default;opacity:.7;}
    .topbar-control.disabled:hover,.topbar-control:disabled:hover{background:var(--veil);color:var(--text-sec);}
    .icon-btn{width:38px;padding:0;justify-content:center;position:relative;}
    .notify-dot{position:absolute;right:8px;top:8px;width:8px;height:8px;border-radius:99px;background:var(--red);border:2px solid var(--bg-elev);}
    .lang-wrap{position:relative;}
    .lang-menu{position:absolute;right:0;top:43px;min-width:98px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);box-shadow:0 14px 34px rgba(0,0,0,.28);overflow:hidden;z-index:20;}
    .lang-option{display:block;width:100%;padding:8px 12px;border:0;background:transparent;color:var(--text-sec);text-align:left;font-size:12px;font-weight:800;cursor:pointer;}
    .lang-option.active,.lang-option:hover{background:rgba(99,102,241,.14);color:var(--text);}
    .wrap{min-width:0;padding:22px 24px 60px;}
    .top{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:0 0 18px;}
    h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em;}
    .sub{color:var(--text-sec);margin-top:5px;font-size:13px;}
    /* KPI + dashboard */
    .ops-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:18px;}
    .ops-hero h1{font-size:24px;font-weight:800;}
    .ops-date{color:var(--text-sec);font-size:13px;}
    .ops-kpis{display:grid;grid-template-columns:repeat(5,minmax(140px,1fr));gap:12px;margin-bottom:18px;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:14px 16px;}
    .kpi-card{cursor:pointer;transition:background .12s,border-color .12s,translate .12s;}
    .kpi-card:hover{background:var(--card-hover);border-color:var(--border-strong);translate:0 -1px;}
    .kpi-card:focus-visible{outline:2px solid var(--accent1);outline-offset:2px;}
    .kpi-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .kpi-icon{width:34px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(99,102,241,.16);color:var(--accent-soft-text);font:10px 'JetBrains Mono',ui-monospace,monospace;}
    .k{color:var(--text-sec);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;}
    .v{font-size:24px;font-weight:600;margin-top:7px;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .trend{margin-top:5px;color:var(--text-muted);font-size:11px;font-weight:700;}
    .trend.bad{color:var(--red);}
    .trend.good{color:var(--green);}
    .ops-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
    .ops-panel{min-height:190px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:16px 18px;overflow:hidden;}
    .ops-panel-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-size:14px;font-weight:800;}
    .panel-link{border:0;background:transparent;color:var(--accent-soft-text);font-size:12px;font-weight:700;cursor:pointer;}
    .pipeline{display:grid;grid-template-columns:repeat(7,1fr);align-items:end;gap:10px;height:132px;padding-top:10px;}
    .pipe-day{display:grid;grid-template-rows:1fr auto;gap:7px;min-width:0;text-align:center;color:var(--text-muted);font-size:10.5px;font-weight:700;}
    .pipe-bars{height:100%;display:flex;align-items:end;justify-content:center;gap:3px;}
    .pipe-bar{width:7px;min-height:6px;border-radius:7px 7px 2px 2px;background:var(--accent1);}
    .pipe-bar.approved{background:var(--green);}
    .pipe-bar.closed{background:var(--amber);}
    .compact-list{display:grid;gap:8px;}
    .compact-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--veil);}
    .compact-row strong{font-size:12px;}
    .compact-row span{font-size:11px;color:var(--text-muted);}
    .risk{color:var(--red);font-weight:800;}
    .table-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:6px 0 12px;}
    .table-heading h2{margin:0;font-size:16px;}
    .table-heading .sub{margin:3px 0 0;}
    .progress-track{height:5px;border-radius:99px;background:rgba(148,163,184,.18);overflow:hidden;margin-top:6px;}
    .progress-fill{height:100%;border-radius:99px;background:var(--accent2);}
    /* toolbar + collapsible filters (moved OUT of the sidebar) */
    .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
    .filter-count{min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:var(--accent1);color:#fff;font-size:10.5px;font-weight:700;line-height:19px;text-align:center;display:none;}
    .settings-wrap{position:relative;}
    .settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:12;width:min(430px,calc(100vw - 36px));max-height:min(520px,70vh);overflow:auto;padding:14px;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg-elev);box-shadow:var(--shadow);}
    .settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;}
    .settings-head strong{display:block;font-size:13px;}
    .settings-head span{display:block;margin-top:2px;color:var(--text-muted);font-size:11px;}
    .settings-actions{display:flex;gap:6px;flex-wrap:wrap;}
    .columns-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
    .column-option{display:flex;align-items:flex-start;gap:7px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .column-option input{margin-top:2px;}
    .filters-panel{display:none;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:14px;margin-bottom:14px;}
    .filters-panel.open{display:block;}
    .filters-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;}
    .filter-field label{display:block;margin-bottom:4px;color:var(--text-muted);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}
    .filter-row{display:grid;grid-template-columns:1fr;gap:6px;}
    .filter-field select{width:100%;background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:12px;outline:none;}
    .filter-field select[data-filter-mode]{height:34px;appearance:none;-webkit-appearance:none;color:var(--text-sec);background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 7px center;background-size:14px;padding-right:24px;}
    .filter-field select[data-filter-key]{min-height:92px;color:var(--text);}
    .filter-field select[data-filter-key] option{padding:4px 6px;border-radius:6px;}
    .filter-field select option{background:var(--bg-elev);color:var(--text);}
    .filter-field select:focus{border-color:var(--accent1);}
    .filter-summary-head{display:flex;align-items:center;justify-content:space-between;gap:16px;}
    .filter-summary-head strong{display:block;font-size:13px;}
    .filter-summary-head span{display:block;margin-top:2px;color:var(--text-muted);font-size:11px;}
    .active-filter-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px;}
    .active-filter-chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:7px;background:var(--bg-elev);color:var(--text-sec);font-size:11px;}
    .active-filter-chip strong{color:var(--text);font-weight:650;}
    .active-filter-chip button{width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-muted);cursor:pointer;}
    .active-filter-chip button:hover{background:var(--card-hover);color:var(--red);}
    .filter-empty{color:var(--text-muted);font-size:11.5px;}
    .column-filter-popover{position:fixed;z-index:50;width:min(320px,calc(100vw - 24px));padding:12px;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg-elev);box-shadow:var(--shadow);}
    .column-filter-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;}
    .column-filter-head strong{font-size:12.5px;}
    .column-filter-head button{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--text-muted);cursor:pointer;}
    .column-filter-head button:hover{background:var(--card-hover);color:var(--text);}
    .column-filter-search{display:flex;align-items:center;gap:7px;height:36px;padding:0 9px;border:1px solid var(--border);border-radius:8px;background:var(--card);}
    .column-filter-search input{min-width:0;width:100%;border:0;background:transparent;color:var(--text);font-size:12px;}
    .column-filter-sort{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:9px;}
    .column-filter-sort button{display:flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 8px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text-sec);font-size:11.5px;font-weight:600;cursor:pointer;}
    .column-filter-sort button:hover{border-color:var(--accent1);color:var(--text);}
    .column-filter-tools{display:flex;justify-content:space-between;gap:8px;padding:9px 1px 7px;}
    .column-filter-tools button{padding:0;border:0;background:transparent;color:var(--accent1);font-size:11px;font-weight:650;cursor:pointer;}
    .column-filter-values{display:grid;gap:2px;max-height:250px;overflow:auto;padding:3px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);}
    .column-filter-value{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 5px;border-radius:7px;color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .column-filter-value:hover{background:var(--card-hover);color:var(--text);}
    .column-filter-value span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .column-filter-actions{display:flex;justify-content:flex-end;gap:7px;padding-top:10px;}
    /* table */
    .table-shell{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;}
    .scroll::-webkit-scrollbar{width:11px;height:11px;}
    .scroll::-webkit-scrollbar-thumb{border:3px solid var(--bg-elev);border-radius:999px;background:var(--border-strong);}
    .scroll::-webkit-scrollbar-track{background:var(--bg-elev);}
    .scroll{overflow:auto;max-height:calc(100dvh - 315px);scrollbar-gutter:stable;}
    table{border-collapse:separate;border-spacing:0;min-width:2750px;width:100%;font-size:12.5px;}
    th,td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:9px 10px;white-space:nowrap;text-align:left;}
    /* every Excel-like grid: fixed layout so the column widths are ours to set */
    table.grid{table-layout:fixed;}
    table.grid th,table.grid td{overflow:hidden;text-overflow:ellipsis;}
    th{position:sticky;top:33px;z-index:2;background:var(--card-hover);font-weight:600;color:var(--text-sec);font-size:11.5px;}
    th.group{top:0;background:var(--bg-elev);color:var(--accent1);text-align:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;}
    .header-cell-control{display:flex;align-items:center;gap:5px;min-width:0;padding-right:8px;}
    .header-cell-control>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .sort-head{min-width:0;flex:1;display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0;}
    .sort-head:hover{color:var(--text);}
    .sort-mark{flex:none;color:var(--text-muted);font-size:10px;}
    .sort-head.active .sort-mark{color:var(--accent2);}
    .column-filter-button{width:24px;height:24px;display:grid;place-items:center;flex:0 0 auto;border:0;border-radius:6px;background:transparent;color:var(--text-muted);cursor:pointer;}
    .column-filter-button:hover,.column-filter-button.active{background:var(--ring);color:var(--accent1);}
    .column-filter-button .ti{font-size:15px;}
    th.sticky-col,td.sticky-col{position:sticky;left:0;z-index:3;background:var(--card);box-shadow:1px 0 0 var(--border);}
    th.sticky-col{z-index:5;background:var(--card-hover);}
    th.sticky-actions,td.sticky-actions{position:sticky;right:0;z-index:3;background:var(--card);box-shadow:-1px 0 0 var(--border);}
    th.sticky-actions{z-index:5;background:var(--card-hover);}
    tr:nth-child(even) td{background:color-mix(in srgb,var(--card) 97%,var(--text) 3%);}
    .num{text-align:right;font-variant-numeric:tabular-nums;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .actions{display:flex;gap:6px;}
    .mini{border:1px solid var(--border);border-radius:9px;padding:6px 9px;background:transparent;color:var(--text-sec);font-weight:600;font-size:12px;cursor:pointer;}
    .mini:hover{background:var(--card-hover);}
    .mini.save{color:var(--green);}
    .mini.delete{color:var(--red);}
    .dirty td{background:rgba(245,158,11,0.08) !important;}
    .table-empty{padding:38px 18px;color:var(--text-muted);text-align:center;}
    .table-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-top:1px solid var(--border);background:var(--bg-elev);flex-wrap:wrap;}
    .pager-info{color:var(--text-sec);font-size:12px;}
    .pager-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .pager-actions select{height:32px;border:1px solid var(--border);border-radius:8px;background:var(--bg-elev);color:var(--text-sec);padding:0 8px;outline:none;}
    .pager-actions select option{background:var(--bg-elev);color:var(--text);}
    .pager-btn{min-width:32px;height:32px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--text-sec);cursor:pointer;}
    .pager-btn:hover:not(:disabled){border-color:var(--border-strong);background:var(--card-hover);color:var(--text);}
    .pager-btn:disabled{opacity:.38;cursor:not-allowed;}
    /* ── create view (ported from the confirmed «Новая заявка» mock) ── */
    .form-wrap{width:100%;max-width:none;}
    .create-stepper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 18px;}
    .create-step-indicator{display:flex;align-items:center;gap:9px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--text-muted);font-size:12px;font-weight:600;}
    .create-step-indicator .step-dot{width:24px;height:24px;display:grid;place-items:center;flex:none;border-radius:8px;background:var(--veil);font-size:11px;}
    .create-step-indicator.active{border-color:var(--accent1);color:var(--text);box-shadow:0 0 0 3px var(--ring);}
    .create-step-indicator.active .step-dot{background:var(--accent1);color:#fff;}
    .create-step-indicator.done{border-color:var(--green-bd);color:var(--green);}
    .create-step-indicator.done .step-dot{background:var(--green-bg);}
    .create-review{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}
    .create-review-block{padding:13px;border:1px solid var(--border);border-radius:12px;background:var(--veil);}
    .create-review-block strong{display:block;margin-bottom:6px;font-size:12px;color:var(--text-sec);}
    .create-review-block span{display:block;font-size:13px;white-space:pre-wrap;}
    .create-review-block.full{grid-column:1/-1;}
    .fcard{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:22px 24px;margin-bottom:18px;}
    .fcard-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;margin:0 0 16px;}
    .num-badge{width:22px;height:22px;border-radius:7px;background:rgba(99,102,241,0.18);color:var(--accent-soft-text);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;}
    .fcard-title small{font-weight:400;font-size:12px;color:var(--text-muted);margin-left:4px;}
    label.f{display:block;font-size:12px;color:var(--text-sec);margin-bottom:6px;font-weight:500;}
    label.f .req{color:var(--red);}
    .field{margin-bottom:14px;}
    .field-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px;}
    .fin,select.fin,textarea.fin{width:100%;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-ctl);padding:10px 12px;font-size:13.5px;outline:none;transition:border-color .12s;}
    .fin:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    select.fin{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 10px center;background-size:16px;padding-right:32px;}
    select.fin option{background:var(--bg-elev);color:var(--text);}
    textarea.fin{resize:vertical;min-height:70px;}
    textarea.fin.auto-expand{resize:none;overflow:hidden;min-height:0;height:auto;line-height:1.4;}
    .type-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;}
    .type-card{border:1px solid var(--border);border-radius:14px;padding:14px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;color:var(--text-sec);transition:all .12s;font-size:13px;font-weight:500;}
    .type-card:hover{background:var(--card-hover);}
    .type-card.selected{border-color:var(--accent1);background:rgba(99,102,241,0.10);color:var(--text);}
    .pill-group{display:flex;gap:10px;flex-wrap:wrap;}
    .pill{border:1px solid var(--border);border-radius:999px;padding:8px 15px;cursor:pointer;font-size:13px;color:var(--text-sec);transition:all .12s;background:none;}
    .pill:hover{background:var(--card-hover);}
    .pill.sel-plain{border-color:var(--border-strong);background:rgba(148,163,184,0.12);color:var(--text);}
    .pill.sel-urgent{border-color:var(--amber-bd);background:var(--amber-bg);color:var(--amber);}
    .pill.sel-emergency{border-color:var(--red-bd);background:var(--red-bg);color:var(--red);}
    .warning-banner{display:none;align-items:flex-start;gap:10px;background:var(--red-bg);border:1px solid var(--red-bd);color:var(--red);border-radius:12px;padding:12px 14px;margin-top:12px;font-size:12.5px;}
    .warning-banner.show{display:flex;}
    .items-shell{border:1px solid var(--border);border-radius:14px;overflow-x:auto;}
    table.items{min-width:1040px;width:100%;font-size:13px;border-collapse:separate;border-spacing:0;table-layout:fixed;}
    table.items th{position:static;background:transparent;color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding:10px 8px;border-bottom:1px solid var(--border);border-right:none;}
    table.items td{padding:5px 6px;border-bottom:1px solid var(--border);border-right:none;vertical-align:middle;}
    table.items tr:last-child td{border-bottom:none;}
    table.items input,table.items select,table.items textarea{width:100%;border:1px solid transparent;background:transparent;border-radius:8px;padding:7px 8px;font-size:13px;outline:none;}
    table.items textarea{display:block;min-height:34px;resize:none;overflow:hidden;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;}
    table.items input:hover,table.items select:hover,table.items textarea:hover{border-color:var(--border);}
    table.items input:focus,table.items select:focus,table.items textarea:focus{border-color:var(--accent1);background:rgba(255,255,255,0.03);}
    table.items select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 6px center;background-size:14px;padding-right:22px;}
    table.items select option{background:var(--bg-elev);color:var(--text);}
    .nds-cell-control{display:flex;align-items:center;justify-content:center;gap:6px;min-height:34px;color:var(--text-sec);font-size:11px;cursor:pointer;white-space:nowrap;}
    .nds-cell-control input{width:16px!important;height:16px;margin:0;accent-color:var(--accent1);}
    td.idx{color:var(--text-muted);font-size:12.5px;text-align:center;width:34px;}
    .row-x{width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--text-muted);cursor:pointer;font-size:15px;line-height:1;}
    .row-x:hover{color:var(--red);border-color:var(--red-bd);}
    .row-x:disabled{opacity:.3;cursor:not-allowed;}
    .add-row-btn{width:100%;margin-top:12px;padding:10px;border:1px dashed var(--border-strong);border-radius:12px;background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer;}
    .add-row-btn:hover{background:var(--card-hover);border-color:var(--accent1);color:var(--text);}
    .total-row{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:13px;padding-top:13px;border-top:1px solid var(--border);}
    .total-row .lbl{color:var(--text-sec);font-size:13px;}
    .total-row .val{font-size:18px;font-weight:600;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .form-actions{display:flex;justify-content:space-between;gap:10px;margin-top:4px;}
    .err-line{color:var(--red);font-size:12.5px;min-height:18px;margin-bottom:8px;}
    /* ── access administration ── */
    .admin-stats{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));gap:12px;margin-bottom:16px;}
    .admin-stat{padding:15px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card);}
    .admin-stat strong{display:block;margin-bottom:2px;font-size:23px;font-weight:600;}
    .admin-stat span{color:var(--text-muted);font-size:11.5px;}
    .admin-panel{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--card);}
    .admin-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);}
    .admin-panel-head strong{font-size:13px;}
    .admin-search{width:min(310px,45vw);padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:var(--veil);outline:none;}
    .admin-search:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,.13);}
    .people-list{min-width:720px;}
    .people-row{display:grid;grid-template-columns:minmax(210px,1.25fr) minmax(150px,.9fr) minmax(210px,1.25fr) 100px 96px;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--border);}
    .people-row:last-child{border-bottom:0;}
    .people-row.head{color:var(--text-muted);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--veil);}
    .identity{display:flex;align-items:center;gap:10px;min-width:0;}
    .avatar{width:34px;height:34px;display:grid;place-items:center;flex:none;border-radius:10px;background:linear-gradient(135deg,rgba(99,102,241,.24),rgba(34,211,238,.15));color:var(--accent-soft-text);font-size:11px;font-weight:700;}
    .identity-name{overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;}
    .identity-meta{overflow:hidden;color:var(--text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap;}
    .role-list{display:flex;gap:5px;flex-wrap:wrap;}
    .role-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid rgba(99,102,241,.22);border-radius:999px;background:rgba(99,102,241,.10);color:var(--accent-soft-text);font-size:10.5px;}
    .status-dot{display:inline-flex;align-items:center;gap:6px;color:var(--text-sec);font-size:11.5px;}
    .status-dot:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--text-muted);}
    .status-dot.active:before{background:var(--green);box-shadow:0 0 0 3px var(--green-bg);}
    .mini-action{padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--veil);color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .mini-action:hover{border-color:var(--border-strong);color:var(--text);}
    .mini-action.danger{border-color:var(--red-bd);background:var(--red-bg);color:var(--red);}
    .mini-action:disabled{opacity:.55;cursor:wait;}
    .empty-admin{padding:42px 20px;color:var(--text-muted);text-align:center;}
    .roles-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;}
    .role-card{min-height:170px;padding:16px;border:1px solid var(--border);border-radius:15px;background:var(--card);}
    .role-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:13px;}
    .role-card h3{margin:0;font-size:14px;}
    .role-code{margin-top:3px;color:var(--text-muted);font:10.5px 'IBM Plex Mono',ui-monospace,monospace;}
    .role-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;}
    .role-count{padding:4px 7px;border-radius:999px;background:var(--veil);color:var(--text-sec);font-size:10px;white-space:nowrap;}
    .role-perms{display:flex;gap:5px;flex-wrap:wrap;max-height:72px;overflow:hidden;}
    .perm-chip{padding:3px 6px;border-radius:6px;background:rgba(34,211,238,.07);color:#A5D8E5;font:9.5px 'IBM Plex Mono',ui-monospace,monospace;}
    /* ── Excel-like grids (Снабжение, Номенклатура, Поставщики share one shell) ── */
    .grid-host{display:block;}
    .grid-host .toolbar{margin-bottom:12px;}
    /* the toolbar search is a standalone control here (the navbar one lives in a wrapper) */
    .grid-host .search{flex:1;min-width:220px;max-width:360px;padding:10px 12px;border:1px solid var(--border);border-radius:11px;background:var(--veil);}
    .grid-host .search:focus{border-color:var(--accent1);box-shadow:0 0 0 3px var(--ring);}
    /* catalogs have no grouped header row, so their header sticks to the very top */
    .grid-host table.grid th{top:0;}
    /* keep the pager on screen: header + toolbar above, pager below */
    .grid-host .scroll{max-height:calc(100dvh - 360px);}
    .top-actions{display:flex;align-items:center;gap:10px;}
    table.grid th.filter-active{color:var(--accent1);}
    table.grid tbody tr:hover td{background:var(--card-hover);}
    /* the resize grip must stay clickable above the header's sort/filter controls
       (header cells are already sticky, so they are the positioning context) */
    .col-resize-handle{position:absolute;top:0;right:0;z-index:4;width:7px;height:100%;cursor:col-resize;user-select:none;touch-action:none;}
    .col-resize-handle:hover,.col-resize-handle.resizing{background:var(--accent1);opacity:.35;}
    body.col-resizing{cursor:col-resize;user-select:none;}
    /* transient state used while measuring content widths for auto-fit */
    table.measuring th,table.measuring td{overflow:visible;text-overflow:clip;}
    table.measuring .col-resize-handle{display:none;}
    .icon-action{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;background:var(--bg-elev);color:var(--text-sec);cursor:pointer;}
    .icon-action:hover{border-color:var(--border-strong);color:var(--text);}
    .icon-action.danger:hover{border-color:var(--red-bd);background:var(--red-bg);color:var(--red);}
    .row-actions-cell{display:flex;gap:6px;}
    .unit-types-list{display:flex;flex-direction:column;}
    .unit-type-row{display:grid;grid-template-columns:28px 64px 1fr 1fr 1fr 76px;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);}
    .unit-type-row:last-child{border-bottom:0;}
    .unit-type-row.head{color:var(--text-muted);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}
    .unit-type-row:not(.head){cursor:default;}
    .unit-type-row.dragging{opacity:.4;}
    .drag-handle{display:flex;align-items:center;justify-content:center;color:var(--text-muted);cursor:grab;touch-action:none;}
    .drag-handle:active{cursor:grabbing;}
    .checkbox-list{display:flex;flex-wrap:wrap;gap:8px;max-height:160px;overflow-y:auto;padding:4px 0;}
    .checkbox-list label{display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--text-sec);cursor:pointer;}
    .checkbox-list input:checked + span{color:var(--text);font-weight:600;}
    .chip-list{display:flex;flex-wrap:wrap;gap:5px;}
    .chip-list .pill{font-size:10.5px;padding:2px 8px;}
    .unit-type-actions{display:flex;gap:6px;justify-content:flex-end;}
    .modal.wide{width:min(680px,100%);max-height:calc(100dvh - 36px);overflow:auto;}
    .modal-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .modal-field{margin-bottom:12px;}
    .modal-field label{display:block;margin-bottom:6px;color:var(--text-sec);font-size:11.5px;font-weight:600;}
    .modal-field.full{grid-column:1/-1;}
    .row-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .row-edit-grid .modal-field{margin-bottom:0;}
    .permission-groups{display:grid;gap:10px;margin-top:12px;}
    .permission-group{padding:11px;border:1px solid var(--border);border-radius:11px;}
    .permission-group-title{margin-bottom:8px;color:var(--accent-soft-text);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;}
    .permission-options{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
    .permission-option{display:flex;align-items:flex-start;gap:7px;color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .permission-option input{margin-top:2px;}
    /* ── workflow draft designer ── */
    .workflow-notice{display:flex;align-items:flex-start;gap:11px;margin-bottom:16px;padding:13px 15px;border:1px solid var(--amber-bd);border-radius:12px;background:var(--amber-bg);color:var(--amber);}
    .workflow-notice .ti{margin-top:1px;}
    .workflow-notice strong,.workflow-notice span{display:block;}
    .workflow-notice span{margin-top:2px;font-size:11.5px;line-height:1.5;}
    .workflow-layout{display:grid;grid-template-columns:minmax(230px,.72fr) minmax(430px,1.8fr);gap:14px;align-items:start;}
    .workflow-sidebar,.workflow-editor{min-height:430px;}
    .workflow-list-item{width:100%;padding:13px 15px;border:0;border-bottom:1px solid var(--border);background:transparent;color:var(--text);text-align:left;cursor:pointer;}
    .workflow-list-item:hover,.workflow-list-item.active{background:var(--card-hover);}
    .workflow-list-item.active{box-shadow:inset 3px 0 var(--accent1);}
    .workflow-list-name{font-size:12.5px;font-weight:650;}
    .workflow-list-meta{display:flex;align-items:center;gap:6px;margin-top:5px;color:var(--text-muted);font-size:10.5px;}
    .workflow-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px;border-bottom:1px solid var(--border);}
    .workflow-editor-head h2{margin:0;font-size:17px;}
    .workflow-editor-head p{margin:4px 0 0;color:var(--text-muted);font-size:11px;}
    .workflow-steps{display:grid;gap:9px;padding:16px;}
    .workflow-step{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:11px;padding:12px;border:1px solid var(--border);border-radius:11px;background:var(--veil);}
    .workflow-step-order{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:var(--accent1);color:white;font:700 11px 'IBM Plex Mono',monospace;}
    .workflow-step-name{font-size:12.5px;font-weight:650;}
    .workflow-step-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px;color:var(--text-muted);font-size:10.5px;}
    .workflow-step-actions{display:flex;gap:5px;}
    .workflow-readonly{padding:10px 16px;border-bottom:1px solid var(--border);background:var(--veil);color:var(--text-muted);font-size:11px;}
    /* ── shared request workflow ── */
    .request-tabs{display:flex;gap:5px;padding:4px;border:1px solid var(--border);border-radius:11px;background:var(--veil);}
    .request-tab{padding:7px 11px;border:0;border-radius:8px;background:transparent;color:var(--text-sec);font-size:11.5px;font-weight:600;cursor:pointer;}
    .request-tab.active{background:rgba(99,102,241,.18);color:var(--accent-soft-text);}
    .request-list{display:grid;gap:8px;}
    .request-row{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(130px,.7fr) minmax(120px,.65fr) minmax(110px,.55fr) minmax(26px,auto);align-items:center;gap:16px;padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card);cursor:pointer;transition:border-color .12s,background .12s,translate .12s;}
    .request-row:hover{border-color:var(--border-strong);background:var(--card-hover);translate:0 -1px;}
    .request-number{color:var(--accent-soft-text);font:10.5px 'IBM Plex Mono',ui-monospace,monospace;}
    .request-title{margin-top:3px;font-size:13.5px;font-weight:600;}
    .request-meta{color:var(--text-muted);font-size:11px;}
    .request-status{display:inline-flex;width:max-content;padding:5px 8px;border:1px solid rgba(99,102,241,.23);border-radius:999px;background:rgba(99,102,241,.09);color:var(--accent-soft-text);font-size:10.5px;font-weight:600;}
    .request-priority{font-size:11.5px;color:var(--text-sec);}
    .request-priority.high,.request-priority.urgent,.request-priority.critical{color:var(--amber);}
    .request-arrow{color:var(--text-muted);font-size:18px;text-align:right;}
    .request-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;}
    .modal.detail-modal{width:min(940px,100%);max-height:calc(100dvh - 28px);overflow:auto;padding:0;}
    .detail-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:19px 20px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg-elev) 96%,transparent);backdrop-filter:blur(8px);}
    .detail-head h2{margin:3px 0 0;font-size:20px;}
    .icon-close{width:36px;height:36px;border:1px solid var(--border);border-radius:10px;background:var(--veil);color:var(--text-sec);cursor:pointer;}
    .detail-body{padding:18px 20px 22px;}
    .detail-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px;}
    .detail-cell{padding:10px 11px;border:1px solid var(--border);border-radius:11px;background:var(--veil);}
    .detail-cell span{display:block;margin-bottom:4px;color:var(--text-muted);font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;}
    .detail-cell strong{font-size:12px;font-weight:600;}
    .detail-section{margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:13px;background:var(--veil);}
    .detail-section-title{margin-bottom:10px;color:var(--text-sec);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}
    .detail-items{width:100%;min-width:650px;border-collapse:collapse;font-size:11.5px;}
    .detail-items th,.detail-items td{padding:8px;border-bottom:1px solid var(--border);text-align:left;}
    .detail-items th{position:static;top:auto;color:var(--text-muted);font-size:9.5px;text-transform:uppercase;}
    .stock-choice{display:flex;gap:4px;}
    .stock-choice button{padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-muted);font-size:9.5px;cursor:pointer;}
    .stock-choice button.selected{border-color:var(--green-bd);background:var(--green-bg);color:var(--green);}
    .stock-choice button.out.selected{border-color:var(--red-bd);background:var(--red-bg);color:var(--red);}
    .timeline{display:grid;gap:0;}
    .timeline-step{position:relative;display:grid;grid-template-columns:18px 1fr;gap:10px;padding:0 0 13px;}
    .timeline-step:not(:last-child):before{content:'';position:absolute;left:6px;top:13px;bottom:0;width:1px;background:var(--border-strong);}
    .timeline-dot{position:relative;z-index:1;width:13px;height:13px;margin-top:2px;border:2px solid var(--text-muted);border-radius:50%;background:var(--bg-elev);}
    .timeline-step.completed .timeline-dot{border-color:var(--green);background:var(--green);}
    .timeline-step.current .timeline-dot{border-color:var(--accent1);box-shadow:0 0 0 4px rgba(99,102,241,.14);}
    .timeline-step.rejected .timeline-dot,.timeline-step.returned .timeline-dot{border-color:var(--red);background:var(--red);}
    .timeline-name{font-size:11.5px;font-weight:600;}
    .timeline-meta{margin-top:2px;color:var(--text-muted);font-size:10.5px;}
    .detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px;}
    .action-btn{padding:10px 13px;border:1px solid rgba(99,102,241,.28);border-radius:10px;background:rgba(99,102,241,.14);color:var(--accent-soft-text);font-size:11.5px;font-weight:650;cursor:pointer;}
    .action-btn.danger{border-color:var(--red-bd);background:var(--red-bg);color:var(--red);}
    .action-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
    .action-fields .full{grid-column:1/-1;}
    .quote-list,.quote-item-fields{display:grid;gap:8px;}
    .quote-card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--veil);font-size:11.5px;}
    .quote-card.selected{border-color:var(--green-bd);background:var(--green-bg);}
    .quote-item-fields>label{display:grid;grid-template-columns:minmax(180px,1fr) minmax(130px,.45fr);align-items:center;gap:10px;color:var(--text-sec);font-size:11.5px;}
    .quote-entry-line{display:grid;gap:8px;padding:10px;border:1px solid var(--border);border-radius:9px;background:var(--veil);}
    .quote-entry-name{font-size:11.5px;font-weight:650;line-height:1.4;overflow-wrap:anywhere;}
    .quote-entry-controls{display:grid;grid-template-columns:minmax(110px,1fr) minmax(105px,.72fr) 86px;gap:8px;align-items:center;}
    .quote-entry-nds{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:38px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;color:var(--text-sec);font-size:11px;cursor:pointer;}
    .quote-entry-nds input{width:16px;height:16px;accent-color:var(--accent1);}
    /* misc */
    .toast{position:fixed;right:18px;bottom:18px;max-width:min(420px,calc(100vw - 36px));border:1px solid var(--border-strong);border-radius:10px;background:var(--text);color:var(--bg-elev);padding:12px 15px;font-weight:500;z-index:40;box-shadow:var(--shadow);}
    .modal-backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:18px;background:var(--overlay);z-index:30;overflow:auto;}
    .modal{width:min(420px,100%);border-radius:12px;background:var(--bg-elev);border:1px solid var(--border);padding:20px;box-shadow:var(--shadow);}
    .modal h2{margin:0 0 8px;font-size:17px;}
    .modal p{margin:0 0 16px;color:var(--text-sec);font-size:13px;}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;}
    .err{color:var(--red);font-size:13px;min-height:18px;}
    .hidden{display:none !important;}
    .backdrop{display:none;}
    body.sidebar-open{overflow:hidden;}
    body.sidebar-open .backdrop{display:block;position:fixed;inset:0;z-index:20;background:rgba(4,7,14,.6);}
    @media (max-width:760px){
      .login{padding:14px;place-items:stretch;}
      .login-shell{min-height:calc(100dvh - 28px);grid-template-columns:1fr;}
      .login-story{min-height:210px;padding:26px;}
      .login-story h1{font-size:31px;margin-bottom:10px;}
      .login-story p{font-size:12.5px;}
      .flow-line{display:none;}
      .login-panel{padding:28px 24px 32px;align-items:flex-start;}
      .app-shell{display:block;}
      .wrap{padding:14px 14px 40px;}
      .navbar{padding:10px 14px;}
      .menu-btn{display:grid;place-items:center;}
      .nav-actions .search{display:none;}
      .top{align-items:stretch;flex-direction:column;}
      .cards{grid-template-columns:repeat(2,minmax(0,1fr));}
      .ops-hero{align-items:stretch;flex-direction:column;}
      .ops-kpis{grid-template-columns:repeat(2,minmax(0,1fr));}
      .ops-grid,.ops-grid[style]{grid-template-columns:1fr !important;}
      .sidebar{position:fixed;inset:0 auto 0 0;z-index:30;width:min(300px,calc(100vw - 42px));height:100dvh;transform:translateX(-105%);transition:transform .2s ease;}
      body.sidebar-open .sidebar{transform:translateX(0);}
      .field-row{grid-template-columns:1fr;}
      .admin-stats{grid-template-columns:1fr 1fr;}
      .modal-form-grid,.permission-options,.columns-grid{grid-template-columns:1fr;}
      .modal-field.full{grid-column:auto;}
      .request-row{grid-template-columns:1fr auto;gap:8px 12px;}
      .request-row>div:nth-child(2),.request-row>div:nth-child(3),.request-row>div:nth-child(4){display:none;}
      .detail-summary{grid-template-columns:1fr 1fr;}
      .action-fields{grid-template-columns:1fr;}
      .action-fields .full{grid-column:auto;}
      .quote-entry-controls{grid-template-columns:1fr 1fr;}
      .quote-entry-nds{grid-column:1/-1;}
      .workflow-layout{grid-template-columns:1fr;}
      .scroll{max-height:calc(100vh - 340px);}
      .topbar-control{display:none;}
      .search-wrap{width:min(460px,58vw);}
    }
    @media (min-width:761px){ .mobile-search{display:none;} }

    /* ── Procurement control desk: one semantic token system ─────────────── */
    body{background:var(--bg);letter-spacing:-.005em;}
    .ti{display:inline-block;flex:0 0 auto;font-size:18px;line-height:1;vertical-align:-.12em;}
    .side-label .ti{width:20px;text-align:center;font-size:19px;}
    .btn .ti,.topbar-control .ti{font-size:17px;}
    .icon-btn .ti,.menu-btn .ti{font-size:20px;}
    button,input,select,textarea{outline:none;}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{box-shadow:0 0 0 3px var(--ring);border-color:var(--accent1)!important;}
    .app-shell{grid-template-columns:252px minmax(0,1fr);}
    .sidebar{padding:18px 14px 14px;background:var(--bg-elev);border-color:var(--border);}
    .side-brand{height:48px;padding:0 6px 14px;margin-bottom:12px;border-color:var(--border);font-size:14px;letter-spacing:-.02em;}
    .brand-dot{width:34px;height:34px;border-radius:9px;background:var(--text);color:var(--bg-elev);box-shadow:none;font-size:13px;}
    .side-brand>div>span{color:var(--accent1)!important;}
    .side-caption{font-size:10px;letter-spacing:.08em;text-transform:uppercase;}
    .nav-sec{padding:18px 10px 7px;font-size:10px;letter-spacing:.12em;}
    .side-link{min-height:40px;padding:9px 10px;border-radius:8px;color:var(--text-sec);font-size:13px;font-weight:600;}
    .side-link:hover{background:var(--card-hover);color:var(--text);}
    .side-link.active{background:var(--text);color:var(--bg-elev);box-shadow:0 1px 2px rgba(16,24,40,.12);}
    .side-link.active svg,.side-link.active .ti{color:var(--bg-elev);}
    .side-badge{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-bd);}
    .side-bottom{border-color:var(--border);}
    .side-user{padding:7px 5px;}
    .side-avatar{border-radius:8px;background:var(--card-hover);border:1px solid var(--border);color:var(--text);}
    .navbar{min-height:68px;padding:10px 28px;background:color-mix(in srgb,var(--bg-elev) 94%,transparent);border-color:var(--border);backdrop-filter:blur(14px);}
    .nav-left{flex:0 1 260px;}
    .nav-actions{flex:1;justify-content:flex-end;}
    .brand-title{font-size:14px;font-weight:700;}
    .brand-sub{font-size:11px;}
    .search-wrap,.topbar-control,.icon-btn{background:var(--bg-elev);border-color:var(--border);border-radius:8px;}
    .search-wrap{height:40px;width:auto;min-width:180px;max-width:430px;flex:1;}
    .search-wrap:focus-within{box-shadow:0 0 0 3px var(--ring);}
    .topbar-control:hover,.icon-btn:hover{background:var(--card-hover);}
    .wrap{padding:28px 30px 64px;}
    .ops-hero{align-items:center;margin-bottom:20px;}
    .ops-hero h1{font-size:28px;line-height:1.2;letter-spacing:-.035em;}
    .ops-date{margin-top:6px;color:var(--text-sec);}
    .ops-kpis{grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:14px;}
    .card,.ops-panel,.table-shell,.filters-panel,.fcard,.admin-panel,.admin-stat,.request-row,.role-card{background:var(--card);border-color:var(--border);border-radius:var(--radius-card);box-shadow:0 1px 2px rgba(16,24,40,.035);}
    .kpi-card{min-width:0;min-height:126px;padding:17px;overflow:hidden;}
    .kpi-card:hover{background:var(--card);border-color:var(--border-strong);translate:0 -1px;box-shadow:0 8px 18px -14px rgba(16,24,40,.35);}
    .kpi-head{align-items:flex-start;}
    .k{max-width:110px;color:var(--text-sec);font-size:10px;letter-spacing:.09em;line-height:1.35;}
    .kpi-icon{width:30px;height:30px;padding:0;border-radius:7px;background:var(--card-hover);border:1px solid var(--border);color:var(--text-sec);display:grid;place-items:center;}
    .kpi-icon .ti{font-size:17px;}
    .v{min-width:0;margin-top:11px;overflow:hidden;color:var(--text);font-size:27px;letter-spacing:-.045em;text-overflow:ellipsis;white-space:nowrap;}
    #kAmount{font-size:clamp(17px,1.55vw,25px);}
    .trend{font-size:10.5px;font-weight:600;}
    .ops-grid{grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;}
    .ops-panel{min-height:210px;padding:18px;}
    .ops-panel:nth-child(1){grid-column:span 8;}
    .ops-panel:nth-child(2){grid-column:span 4;}
    .ops-panel:nth-child(3){grid-column:span 12;min-height:auto;}
    .ops-panel-title{margin-bottom:18px;font-size:13px;}
    .panel-link{color:var(--accent1);font-size:11px;}
    .pipeline{height:auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;padding:18px 0 4px;align-items:start;}
    .rail-stage{position:relative;min-width:0;padding-right:18px;}
    .rail-stage:not(:last-child):after{content:'';position:absolute;left:32px;right:0;top:10px;height:2px;background:var(--border);}
    .rail-node{position:relative;z-index:1;width:22px;height:22px;display:grid;place-items:center;border:5px solid var(--card);border-radius:999px;background:var(--accent1);box-shadow:0 0 0 1px var(--accent1);}
    .rail-stage.done .rail-node{background:var(--green);box-shadow:0 0 0 1px var(--green);}
    .rail-stage.warn .rail-node{background:var(--amber);box-shadow:0 0 0 1px var(--amber);}
    .rail-value{margin-top:16px;font:700 22px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.05em;}
    .rail-label{margin-top:3px;color:var(--text-sec);font-size:11px;font-weight:650;}
    .rail-note{margin-top:4px;color:var(--text-muted);font-size:10px;}
    .compact-list{gap:7px;}
    .compact-row{min-height:42px;padding:9px 10px;background:var(--bg);border-color:var(--border);border-radius:8px;}
    .compact-row strong{font-size:11.5px;}
    .compact-row span{font-size:10.5px;}
    .progress-track{height:4px;background:var(--border);}
    .progress-fill{background:var(--accent1);}
    .top h1{font-size:25px;letter-spacing:-.03em;}
    .sub{color:var(--text-sec);}
    .btn{min-height:38px;padding:9px 14px;border-radius:8px;background:var(--accent1);box-shadow:0 1px 2px rgba(16,24,40,.1);font-size:12px;font-weight:700;transition:background .12s,box-shadow .12s,translate .12s;}
    .btn:hover{filter:none;translate:0 -1px;box-shadow:0 4px 10px -6px rgba(21,94,239,.7);}
    .btn.secondary,.btn.ghost{background:var(--bg-elev);border:1px solid var(--border);color:var(--text-sec);box-shadow:none;}
    .btn.secondary:hover,.btn.ghost:hover{background:var(--card-hover);color:var(--text);}
    .toolbar{gap:8px;}
    .settings-panel,.lang-menu{background:var(--bg-elev);border-color:var(--border);border-radius:10px;box-shadow:0 18px 40px rgba(16,24,40,.16);}
    .column-option,.filter-field select,.fin,select.fin,textarea.fin,.items input,.items select,.admin-search{background:var(--bg-elev);border-color:var(--border);border-radius:8px;}
    .column-option:hover{background:var(--card-hover);}
    table.items input:focus,table.items select:focus{background:var(--bg-elev);}
    .perm-chip{background:color-mix(in srgb,var(--accent1) 12%,transparent);color:var(--accent1);}
    .table-shell{overflow:hidden;}
    .scroll{max-height:calc(100dvh - 315px);}
    table{font-size:12px;}
    th,td{padding:10px 11px;border-color:var(--border);}
    th{background:var(--card-hover);color:var(--text-sec);}
    th.group{background:var(--bg-elev);color:var(--accent1);}
    tr:nth-child(even) td{background:color-mix(in srgb,var(--card) 97%,var(--text) 3%);}
    tbody tr:hover td{background:var(--card-hover);}
    .table-pager{background:var(--bg-elev);border-color:var(--border);}
    .mini,.pager-btn{border-color:var(--border);border-radius:7px;}
    .fcard{padding:22px;margin-bottom:14px;}
    .num-badge{border-radius:6px;background:var(--text);color:var(--bg-elev);}
    .type-card{border-color:var(--border);border-radius:9px;background:var(--bg-elev);}
    .type-card.selected{border-color:var(--accent1);background:var(--ring);}
    .pill{border-color:var(--border);background:var(--bg-elev);border-radius:8px;}
    .items-shell{border-color:var(--border);border-radius:10px;}
    .items th{background:var(--card-hover);}
    .modal-backdrop{background:var(--overlay);backdrop-filter:blur(3px);}
    .modal{background:var(--bg-elev);border-color:var(--border);border-radius:12px;box-shadow:var(--shadow);}
    .modal.wide{padding:0;overflow:hidden;}
    .modal.wide>h2,.modal.wide>p,.modal.wide>.err{margin-left:20px;margin-right:20px;}
    .modal.wide>h2{margin-top:20px;}
    .row-edit-grid,.modal-form-grid,.permission-groups,#actionFields{max-height:calc(100dvh - 220px);overflow:auto;padding:0 20px 16px;scrollbar-gutter:stable;}
    .modal-actions{position:sticky;bottom:0;margin-top:0;padding:14px 20px;border-top:1px solid var(--border);background:var(--bg-elev);z-index:2;}
    .toast{background:var(--text);color:var(--bg-elev);border:0;border-radius:9px;box-shadow:0 14px 30px rgba(16,24,40,.22);}
    .login-shell{color:#F8FAFC;}
    .login-story h1,.login-card h2,.login-brand{color:#F8FAFC;}
    .login-story p,.login-card .sub,.login-note{color:#98A2B3;}
    .login-field label{color:#D0D5DD;}
    .login-input{color:#F8FAFC;}
    .login-input::placeholder{color:#667085;}
    @media (max-width:1180px){
      .ops-kpis{grid-template-columns:repeat(3,minmax(0,1fr));}
      .ops-panel:nth-child(1),.ops-panel:nth-child(2){grid-column:span 6;}
    }
    @media (max-width:760px){
      .app-shell{display:block;}
      .wrap{padding:18px 14px 44px;}
      .navbar{padding:10px 14px;}
      .ops-kpis{grid-template-columns:repeat(2,minmax(0,1fr));}
      .ops-panel:nth-child(n){grid-column:1/-1;}
      .pipeline{overflow-x:auto;grid-template-columns:repeat(4,minmax(140px,1fr));}
      .login-shell{border-radius:16px;}
      .login-story{background:var(--text);}
      .items-shell{overflow:visible;border:0;background:transparent;}
      table.items,.items tbody{display:block;min-width:0;width:100%;}
      .items thead{display:none;}
      .items tbody tr{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);}
      .items td{display:grid;gap:5px;padding:0;border:0;background:transparent!important;white-space:normal;}
      .items td:before{color:var(--text-muted);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;}
      .items td:nth-child(1){display:none;}
      .items td:nth-child(2),.items td:nth-child(9){grid-column:1/-1;}
      .items td:nth-child(2):before{content:'Наименование';}
      .items td:nth-child(3):before{content:'Код товара';}
      .items td:nth-child(4):before{content:'Количество';}
      .items td:nth-child(5):before{content:'Ед. изм';}
      .items td:nth-child(6):before{content:'Цена';}
      .items td:nth-child(7):before{content:'Банк / Нал';}
      .items td:nth-child(8):before{content:'НДС';}
      .items td:nth-child(9):before{content:'Примечание';}
      .items td:nth-child(10){position:absolute;right:24px;margin-top:-4px;}
      .items input,.items select,.items textarea{min-height:40px;padding:8px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-elev);}
    }
  </style>
</head>
<body>
  <main id="login" class="login">
    <div class="login-shell">
      <section class="login-story" aria-label="Factory OS procurement console">
        <div class="login-brand">
          <span class="login-brand-mark" aria-hidden="true">
            <i class="ti ti-building-factory-2" aria-hidden="true"></i>
          </span>
          FACTORY OS / SNAB
        </div>
        <div class="login-story-copy">
          <h1>Снабжение без слепых зон.</h1>
          <p>Единый рабочий контур для заявок, закупок и поставщиков — от потребности до поступления на склад.</p>
        </div>
        <div class="flow-line" aria-hidden="true">
          <span class="flow-node">01</span><span class="flow-link"></span>
          <span class="flow-node">02</span><span class="flow-link"></span>
          <span class="flow-node">03</span>
        </div>
      </section>
      <div class="login-panel">
        <form class="login-card" id="loginForm">
          <div class="login-kicker">Защищённый доступ</div>
          <h2>Вход в систему</h2>
          <div class="sub">Введите имя пользователя и пароль, выданные администратором.</div>
          <div class="login-field">
            <label for="username">Имя пользователя</label>
            <div class="login-input-wrap">
              <span class="login-input-icon" aria-hidden="true"><i class="ti ti-user"></i></span>
              <input class="login-input" id="username" name="username" type="text" placeholder="Например, snab.admin" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
            </div>
          </div>
          <div class="login-field">
            <label for="password">Пароль</label>
            <div class="login-input-wrap">
              <span class="login-input-icon" aria-hidden="true"><i class="ti ti-lock"></i></span>
              <input class="login-input" id="password" name="password" type="password" placeholder="Введите пароль" autocomplete="current-password" required />
              <button class="eye" id="togglePassword" type="button" aria-label="Показать пароль">
                <i class="ti ti-eye" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="err" id="loginErr" role="alert" aria-live="polite"></div>
          <button class="btn login-submit" id="loginSubmit" type="submit">Войти в систему</button>
          <div class="login-note">
            <i class="ti ti-shield-check" aria-hidden="true"></i>
            Сессия сохраняется в этом браузере до выхода из системы.
          </div>
        </form>
      </div>
    </div>
  </main>
  <main id="forcePasswordScreen" class="login hidden">
    <div class="login-shell" style="grid-template-columns:1fr;max-width:460px;">
      <div class="login-panel">
        <form class="login-card" id="forcePasswordForm">
          <div class="login-kicker">Защищённый доступ</div>
          <h2>Придумайте новый пароль</h2>
          <div class="sub">Этот пароль выдал администратор — прежде чем продолжить, задайте свой собственный (минимум 8 символов).</div>
          <div class="login-field">
            <label for="forcePassword1">Новый пароль</label>
            <div class="login-input-wrap">
              <span class="login-input-icon" aria-hidden="true"><i class="ti ti-lock"></i></span>
              <input class="login-input" id="forcePassword1" type="password" autocomplete="new-password" required />
            </div>
          </div>
          <div class="login-field">
            <label for="forcePassword2">Повторите пароль</label>
            <div class="login-input-wrap">
              <span class="login-input-icon" aria-hidden="true"><i class="ti ti-lock"></i></span>
              <input class="login-input" id="forcePassword2" type="password" autocomplete="new-password" required />
            </div>
          </div>
          <div class="err" id="forcePasswordErr" role="alert" aria-live="polite"></div>
          <button class="btn login-submit" id="forcePasswordSubmit" type="submit">Сохранить и продолжить</button>
        </form>
      </div>
    </div>
  </main>
  <main id="app" class="hidden">
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="side-brand"><span class="brand-dot">F</span>
          <div>Factory <span style="color:var(--accent1)">OS</span><div class="side-caption">Operations hub</div></div>
        </div>
        <div class="nav-sec" data-i18n="nav.menu">Меню</div>
        <button class="side-link active" data-view="overview" id="navOverview" type="button" aria-label="Дашборд">
          <span class="side-label"><i class="ti ti-layout-dashboard" aria-hidden="true"></i>
          <span data-i18n="nav.dashboard">Дашборд</span></span>
        </button>
        <button class="side-link" data-view="requests" id="navRequests" type="button">
          <span class="side-label"><i class="ti ti-file-description" aria-hidden="true"></i>
          <span data-i18n="nav.requests">Заявки</span></span> <span class="side-badge" id="inboxBadge">0</span>
        </button>
        <button class="side-link" data-view="create" type="button" aria-label="Новая заявка">
          <span class="side-label"><i class="ti ti-plus" aria-hidden="true"></i>
          <span data-i18n="nav.newRequest">Новая заявка</span></span>
        </button>
        <div class="nav-sec" data-i18n="nav.operations">Операции</div>
        <button class="side-link" data-view="procurement" id="navProcurement" type="button" aria-label="Снабжение"><span class="side-label"><i class="ti ti-shopping-cart" aria-hidden="true"></i><span data-i18n="nav.procurement">Снабжение</span></span></button>
        <button class="side-link" data-view="suppliers" id="navSuppliers" type="button" aria-label="Поставщики"><span class="side-label"><i class="ti ti-truck-delivery" aria-hidden="true"></i><span data-i18n="nav.suppliers">Поставщики</span></span></button>
        <button class="nav-sec-toggle hidden" id="settingsToggle" type="button" aria-expanded="false">
          <span data-i18n="nav.manage">Настройки</span><i class="ti ti-chevron-down" aria-hidden="true"></i>
        </button>
        <div class="settings-group" id="settingsGroup">
        <button class="side-link hidden" data-view="settings" id="navSettings" type="button" aria-label="Настройки"><span class="side-label"><i class="ti ti-settings" aria-hidden="true"></i><span data-i18n="settings.title">Настройки</span></span></button>
        <button class="side-link hidden" data-view="positions" id="navPositions" type="button" aria-label="Должности"><span class="side-label"><i class="ti ti-id-badge-2" aria-hidden="true"></i><span data-i18n="nav.positions">Должности</span></span></button>
        <button class="side-link hidden" data-view="namenklatura" id="navNamenklatura" type="button" aria-label="Номенклатура"><span class="side-label"><i class="ti ti-list-details" aria-hidden="true"></i><span data-i18n="nav.namenklatura">Номенклатура</span></span></button>
        <button class="side-link hidden" data-view="people" id="navPeople" type="button" aria-label="Пользователи">
          <span class="side-label"><i class="ti ti-users" aria-hidden="true"></i>
          <span data-i18n="nav.people">Пользователи</span></span>
        </button>
        <button class="side-link hidden" data-view="roles" id="navRoles" type="button" aria-label="Роли и права">
          <span class="side-label"><i class="ti ti-shield-lock" aria-hidden="true"></i>
          <span data-i18n="nav.roles">Роли и права</span></span>
        </button>
        <button class="side-link hidden" data-view="workflow" id="navWorkflow" type="button" aria-label="Workflow">
          <span class="side-label"><i class="ti ti-list-details" aria-hidden="true"></i>
          <span data-i18n="nav.workflow">Workflow</span></span>
        </button>
        <button class="side-link hidden" data-view="unitTypes" id="navUnitTypes" type="button" aria-label="Единицы измерения">
          <span class="side-label"><i class="ti ti-ruler-2" aria-hidden="true"></i>
          <span data-i18n="nav.unitTypes">Единицы измерения</span></span>
        </button>
        <button class="side-link hidden" data-view="otdels" id="navOtdels" type="button" aria-label="Отделы">
          <span class="side-label"><i class="ti ti-building-factory-2" aria-hidden="true"></i>
          <span data-i18n="nav.otdels">Отделы</span></span>
        </button>
        <button class="side-link hidden" data-view="warehouses" id="navWarehouses" type="button" aria-label="Склады">
          <span class="side-label"><i class="ti ti-building-store" aria-hidden="true"></i>
          <span data-i18n="nav.warehouses">Склады</span></span>
        </button>
        <button class="side-link hidden" data-view="branches" id="navBranches" type="button" aria-label="Филиалы">
          <span class="side-label"><i class="ti ti-building" aria-hidden="true"></i>
          <span data-i18n="nav.branches">Филиалы</span></span>
        </button>
        </div>
        <div class="side-bottom">
          <div class="side-user" id="sideUser">
            <span class="side-avatar" id="sideAvatar">—</span>
            <div style="min-width:0;"><div class="side-user-name" id="sideUserName">—</div><div class="side-user-login" id="sideUserLogin">—</div></div>
          </div>
          <button class="side-link" id="logout" type="button" aria-label="Выйти">
            <span class="side-label"><i class="ti ti-logout" aria-hidden="true"></i>
            <span data-i18n="nav.logout">Выйти</span></span>
          </button>
        </div>
      </aside>
      <div class="backdrop" id="sidebarBackdrop"></div>
      <section class="main-pane">
        <header class="navbar">
          <div class="nav-left">
            <button class="menu-btn" id="menuToggle" type="button" aria-label="Открыть меню">
              <i class="ti ti-menu-2" aria-hidden="true"></i>
            </button>
            <div>
              <div class="brand-title" id="navTitle"></div>
              <div class="brand-sub" id="updated"></div>
            </div>
          </div>
          <div class="nav-actions">
            <div class="lang-wrap">
              <button class="topbar-control" id="factorySwitch" type="button"><i class="ti ti-building-factory-2" aria-hidden="true"></i><span id="factoryLabel">—</span></button>
              <div class="lang-menu hidden" id="factoryMenu"></div>
            </div>
            <div class="lang-wrap">
              <button class="topbar-control" id="langToggle" type="button"><span id="langLabel">RU</span></button>
              <div class="lang-menu hidden" id="langMenu"><button class="lang-option active" data-lang="ru" type="button">RU</button><button class="lang-option" data-lang="uz" type="button">UZ</button><button class="lang-option" data-lang="tr" type="button">TR</button></div>
            </div>
            <button class="icon-btn" id="themeToggle" type="button" aria-label="Переключить тему"><i class="ti ti-sun" id="themeIcon" aria-hidden="true"></i></button>
            <button class="icon-btn" id="notifyButton" type="button" aria-label="Уведомления"><i class="ti ti-bell" aria-hidden="true"></i><span class="notify-dot" id="notifyDot"></span></button>
          </div>
        </header>

        <!-- ── VIEW: overview (KPI + filters + table) ── -->
        <div class="wrap" id="viewOverview">
          <div class="ops-hero">
            <div>
              <h1 id="dashboardGreeting">Операционный дашборд</h1>
              <div class="ops-date" id="dashboardDate">Factory OS · Zelal Textile</div>
            </div>
          </div>
          <section class="ops-kpis">
            <div class="card kpi-card" data-kpi-jump="requests" data-kpi-mode="list" tabindex="0" role="button"><div class="kpi-head"><div class="k">Активные заявки</div><div class="kpi-icon"><i class="ti ti-file-description" aria-hidden="true"></i></div></div><div class="v" id="kRequests">0</div><div class="trend" id="kRequestsTrend">В таблице закупок</div></div>
            <div class="card kpi-card" data-kpi-jump="requests" data-kpi-mode="inbox" tabindex="0" role="button"><div class="kpi-head"><div class="k">Требуют действия</div><div class="kpi-icon"><i class="ti ti-alert-circle" aria-hidden="true"></i></div></div><div class="v" id="kInbox">0</div><div class="trend bad" id="kInboxTrend">Ожидают решения</div></div>
            <div class="card kpi-card" data-kpi-jump="procurement" tabindex="0" role="button"><div class="kpi-head"><div class="k">Позиции</div><div class="kpi-icon"><i class="ti ti-list-details" aria-hidden="true"></i></div></div><div class="v" id="kRows">0</div><div class="trend">Отфильтровано сейчас</div></div>
            <div class="card kpi-card" data-kpi-jump="procurement" tabindex="0" role="button"><div class="kpi-head"><div class="k">Сумма</div><div class="kpi-icon"><i class="ti ti-cash" aria-hidden="true"></i></div></div><div class="v" id="kAmount">0</div><div class="trend">UZS по видимым строкам</div></div>
            <div class="card kpi-card" data-kpi-jump="suppliers" tabindex="0" role="button"><div class="kpi-head"><div class="k">Поставщиков</div><div class="kpi-icon"><i class="ti ti-building-store" aria-hidden="true"></i></div></div><div class="v" id="kSuppliers">0</div><div class="trend good">Контрагенты в выборке</div></div>
          </section>
          <section class="ops-grid">
            <div class="ops-panel">
              <div class="ops-panel-title"><span>Pipeline заявок</span><button class="panel-link" data-view-jump="requests" type="button">Открыть заявки ↗</button></div>
              <div class="pipeline" id="pipelineBars"></div>
            </div>
            <div class="ops-panel">
              <div class="ops-panel-title"><span>Последние события</span><button class="panel-link" data-view-jump="requests" type="button">История ↗</button></div>
              <div class="compact-list" id="recentActivity"></div>
            </div>
            <div class="ops-panel">
              <div class="ops-panel-title"><span>Бюджет vs факт</span><button class="panel-link module-preview-btn" data-module="reports" data-module-title="Отчёты" data-module-note="Бюджет, скорость маршрутов и поставщики" type="button">Отчёты ↗</button></div>
              <div class="compact-list" id="budgetBars"></div>
            </div>
          </section>
        </div>

        <!-- ── VIEW: procurement register ── -->
        <div class="wrap hidden" id="viewProcurement">
          <div class="top">
            <div>
              <h1>Снабжение</h1>
            </div>
          </div>
          <div class="grid-host" id="procurementHost"></div>
        </div>

        <!-- ── VIEW: canonical requests + personal action inbox ── -->
        <div class="wrap hidden" id="viewRequests">
          <div class="top">
            <div>
              <h1>Заявки и согласования</h1>
              <div class="sub">Тот же маршрут и те же действия, что в Telegram Web App</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;"><div class="request-tabs"><button class="request-tab active" data-request-mode="all" type="button">Все заявки</button><button class="request-tab" data-request-mode="inbox" type="button">Требуют действия <span id="inboxCount">0</span></button></div><button class="btn ghost hidden" id="deleteAllRequests" type="button">Удалить все</button></div>
          </div>
          <div class="toolbar"><input class="search" id="requestSearch" placeholder="Номер или название заявки…" /><select class="fin" id="requestStatus" style="width:190px"><option value="">Все статусы</option><option value="pending_approval">На согласовании</option><option value="warehouse_check">Проверка склада</option><option value="procurement">Снабжение</option><option value="finance_payment">Оплата</option><option value="delivery">Доставка</option><option value="receiving">Приёмка</option><option value="closed">Закрыто</option><option value="rejected">Отклонено</option></select></div>
          <div class="request-list" id="requestList"><div class="empty-admin">Загрузка заявок…</div></div>
        </div>

        <!-- ── VIEW: create (ported from the confirmed «Новая заявка» mock) ── -->
        <div class="wrap hidden" id="viewCreate">
          <div class="form-wrap">
            <div class="create-stepper" aria-label="Этапы создания заявки">
              <div class="create-step-indicator active" data-create-step-indicator="1"><span class="step-dot">1</span><span>Детали</span></div>
              <div class="create-step-indicator" data-create-step-indicator="2"><span class="step-dot">2</span><span>Продукты</span></div>
              <div class="create-step-indicator" data-create-step-indicator="3"><span class="step-dot">3</span><span>Проверка</span></div>
            </div>
            <div class="create-step-panel" data-create-step="1">
            <div class="fcard">
              <div class="fcard-title"><span class="num-badge">1</span>Тип и контекст заявки</div>
              <label class="f">Тип заявки <span class="req">*</span></label>
              <div class="type-grid" id="typeGrid"></div>
              <div class="field-row">
                <div class="field">
                  <label class="f">Заявитель <span class="req">*</span></label>
                  <select class="fin" id="fRequester"></select>
                </div>
                <div class="field">
                  <label class="f">Отдел</label>
                  <select class="fin" id="fDepartment"><option value="">—</option></select>
                </div>
              </div>
              <div class="field-row">
                <div class="field">
                  <label class="f">Объект</label>
                  <select class="fin" id="fObject"><option value="">—</option></select>
                </div>
                <div class="field" id="whField">
                  <label class="f">Склад назначения</label>
                  <select class="fin" id="fWarehouse"><option value="">—</option></select>
                </div>
              </div>
              <div class="field" id="originField">
                <label class="f">Происхождение</label>
                <div class="pill-group" id="originPills"></div>
              </div>
            </div>
            </div>

            <div class="create-step-panel hidden" data-create-step="2">
            <div class="fcard">
              <div class="fcard-title"><span class="num-badge">2</span>Параметры заявки</div>
              <div class="field-row">
                <div class="field">
                  <label class="f">Назначение / цель</label>
                  <select class="fin" id="fPurpose"><option value="">—</option></select>
                </div>
                <div class="field">
                  <label class="f">Необходимо к дате</label>
                  <input class="fin" id="fNeeded" type="date" />
                </div>
              </div>
              <label class="f">Степень срочности <span class="req">*</span></label>
              <div class="pill-group" id="urgencyPills"></div>
              <div class="warning-banner" id="emergencyWarning">
                <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                <div>Аварийная заявка требует немедленного согласования — маршрут будет ускорен.</div>
              </div>
            </div>

            <div class="fcard">
              <div class="fcard-title"><span class="num-badge">3</span>Позиции<small>по строкам, как в бумажной заявке</small></div>
              <div class="items-shell">
                <table class="items">
                  <thead><tr>
                    <th style="width:34px;">№</th><th style="width:25%;">Наименование *</th><th style="width:10%;">Код</th>
                    <th style="width:7%;">Кол-во *</th><th style="width:8%;">Ед. изм</th><th style="width:9%;">Цена</th>
                    <th style="width:9%;">Банк/Нал</th><th style="width:7%;">НДС</th><th style="width:21%;">Примечание</th><th style="width:36px;"></th>
                  </tr></thead>
                  <tbody id="itemsBody"></tbody>
                </table>
              </div>
              <button class="add-row-btn" id="addRow" type="button">+ Добавить позицию</button>
              <div class="total-row"><span class="lbl">Итого (ориентировочно):</span><span class="val" id="fTotal">0 UZS</span></div>
            </div>

            <div class="fcard">
              <div class="fcard-title"><span class="num-badge">4</span>Комментарий</div>
              <textarea class="fin" id="fComment" placeholder="Контекст для склада и снабжения: где используется, чем заменить нельзя, особые условия..."></textarea>
            </div>
            </div>

            <div class="create-step-panel hidden" data-create-step="3">
              <div class="fcard">
                <div class="fcard-title"><span class="num-badge">3</span>Проверьте заявку перед отправкой</div>
                <div class="create-review" id="createReview"></div>
              </div>
            </div>

            <div class="err-line" id="formErr"></div>
            <div class="form-actions">
              <button class="btn ghost" id="formCancel" type="button">Отмена</button>
              <div style="display:flex;gap:10px;margin-left:auto;">
                <button class="btn ghost hidden" id="createBack" type="button">← Назад</button>
                <button class="btn" id="createNext" type="button">Далее →</button>
                <button class="btn hidden" id="formSubmit" type="button">Отправить заявку →</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── VIEW: settings hub ── -->
        <div class="wrap hidden" id="viewSettings">
          <div class="top"><div><h1 data-i18n="settings.title">Настройки</h1><div class="sub" data-i18n="settings.subtitle">Справочники, структура, доступ и маршруты Factory OS</div></div></div>
          <div class="roles-grid">
            <button class="role-card" data-view-jump="positions" type="button"><div class="role-card-head"><strong data-i18n="positions.title">Должности</strong><i class="ti ti-id-badge-2"></i></div><p data-i18n="positions.subtitle">Справочник на трёх языках</p></button>
            <button class="role-card" data-view-jump="people" type="button"><div class="role-card-head"><strong data-i18n="people.title">Пользователи</strong><i class="ti ti-users"></i></div><p data-i18n="people.subtitle">Учётные записи и доступ</p></button>
            <button class="role-card" data-view-jump="unitTypes" type="button"><div class="role-card-head"><strong data-i18n="unitTypes.title">Единицы измерения</strong><i class="ti ti-ruler-2"></i></div><p data-i18n="unitTypes.subtitle">Управляемый список единиц</p></button>
            <button class="role-card" data-view-jump="warehouses" type="button"><div class="role-card-head"><strong data-i18n="warehouses.title">Склады</strong><i class="ti ti-building-store"></i></div><p data-i18n="warehouses.subtitle">Склады и ответственные</p></button>
            <button class="role-card" data-view-jump="otdels" type="button"><div class="role-card-head"><strong data-i18n="otdels.title">Отделы</strong><i class="ti ti-building-factory-2"></i></div><p data-i18n="otdels.subtitle">Структура отделов</p></button>
            <button class="role-card" data-view-jump="roles" type="button"><div class="role-card-head"><strong data-i18n="roles.title">Роли и права</strong><i class="ti ti-shield-lock"></i></div><p data-i18n="roles.subtitle">Доступ и workflow</p></button>
          </div>
        </div>

        <!-- ── VIEW: shared users (dashboard + Telegram identities) ── -->
        <div class="wrap hidden" id="viewPeople">
          <div class="top">
            <div>
              <h1 data-i18n="people.title">Пользователи</h1>
              <div class="sub" data-i18n="people.subtitle">Одна учётная запись для dashboard и Telegram Web App</div>
            </div>
            <button class="btn" id="addUser" type="button" data-i18n="people.add">+ Добавить пользователя</button>
          </div>
          <section class="admin-stats">
            <div class="admin-stat"><strong id="usersTotal">0</strong><span data-i18n="people.statTotal">Всего пользователей</span></div>
            <div class="admin-stat"><strong id="usersWeb">0</strong><span data-i18n="people.statWeb">Доступ к dashboard</span></div>
            <div class="admin-stat"><strong id="usersTelegram">0</strong><span data-i18n="people.statTelegram">Связаны с Telegram</span></div>
          </section>
          <section class="admin-panel">
            <div class="admin-panel-head"><strong data-i18n="people.panelTitle">Команда и доступ</strong><input class="admin-search" id="peopleSearch" placeholder="Поиск по имени или логину…" data-i18n-ph="people.searchPlaceholder" /></div>
            <div style="overflow-x:auto;"><div class="people-list" id="peopleList"><div class="empty-admin">Загрузка пользователей…</div></div></div>
          </section>
        </div>

        <!-- ── VIEW: multilingual positions ── -->
        <div class="wrap hidden" id="viewPositions">
          <div class="top"><div><h1 data-i18n="positions.title">Должности</h1><div class="sub" data-i18n="positions.subtitle">Единый справочник должностей на RU, UZ и TR для корректного i18n</div></div><button class="btn" id="addPosition" type="button" data-i18n="positions.add">+ Добавить должность</button></div>
          <section class="admin-panel"><div id="positionsList" class="unit-types-list"><div class="empty-admin">Загрузка…</div></div></section>
        </div>

        <!-- ── VIEW: roles + granular permissions ── -->
        <div class="wrap hidden" id="viewRoles">
          <div class="top">
            <div>
              <h1 data-i18n="roles.title">Роли и права</h1>
              <div class="sub" data-i18n="roles.subtitle">Системные роли едины для dashboard и Telegram; собственные роли можно настраивать</div>
            </div>
            <button class="btn" id="addRole" type="button" data-i18n="roles.add">+ Новая роль</button>
          </div>
          <div class="roles-grid" id="rolesGrid"><div class="empty-admin">Загрузка ролей…</div></div>
        </div>

        <!-- ── VIEW: workflow drafts (configuration only; not activated here) ── -->
        <div class="wrap hidden" id="viewWorkflow">
          <div class="top">
            <div>
              <h1>Workflow</h1>
              <div class="sub">Настройка будущих маршрутов и последовательности шагов</div>
            </div>
            <button class="btn" id="addWorkflow" type="button">+ Новый workflow</button>
          </div>
          <div class="workflow-notice"><i class="ti ti-alert-circle" aria-hidden="true"></i><div><strong>Режим проектирования</strong><span>Изменения здесь пока не применяются к заявкам. Активный системный маршрут доступен только для просмотра.</span></div></div>
          <div class="workflow-layout">
            <section class="admin-panel workflow-sidebar"><div class="admin-panel-head"><strong>Workflow</strong><span class="role-count" id="workflowCount">0</span></div><div id="workflowList"><div class="empty-admin">Загрузка…</div></div></section>
            <section class="admin-panel workflow-editor"><div id="workflowEditor"><div class="empty-admin">Выберите workflow</div></div></section>
          </div>
        </div>

        <!-- ── VIEW: namenklatura (product catalog) ── -->
        <div class="wrap hidden" id="viewNamenklatura">
          <div class="top">
            <div>
              <h1 data-i18n="namenklatura.title">Номенклатура</h1>
              <div class="sub" data-i18n="namenklatura.subtitle">Код, название на трёх языках, категория и единица измерения</div>
            </div>
            <div class="top-actions">
              <button class="btn ghost" id="importMaterial" type="button" data-i18n="common.importExcel"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Импорт из Excel</button>
              <input type="file" id="importMaterialFile" accept=".xlsx,.xls" class="hidden" />
              <button class="btn" id="addMaterial" type="button" data-i18n="namenklatura.add">+ Добавить товар</button>
            </div>
          </div>
          <div class="grid-host" id="namenklaturaHost"></div>
        </div>

        <!-- ── VIEW: postavshiki (suppliers) ── -->
        <div class="wrap hidden" id="viewSuppliers">
          <div class="top">
            <div>
              <h1 data-i18n="suppliers.title">Поставщики</h1>
              <div class="sub" data-i18n="suppliers.subtitle">Контакты, категория и рейтинг поставщиков</div>
            </div>
            <button class="btn" id="addSupplier" type="button" data-i18n="suppliers.add">+ Добавить поставщика</button>
          </div>
          <div class="grid-host" id="suppliersHost"></div>
        </div>

        <!-- ── VIEW: unit types settings ── -->
        <div class="wrap hidden" id="viewUnitTypes">
          <div class="top">
            <div>
              <h1 data-i18n="unitTypes.title">Единицы измерения</h1>
              <div class="sub" data-i18n="unitTypes.subtitle">Управляемый список — используется в заявках и номенклатуре</div>
            </div>
            <div class="top-actions">
              <button class="btn ghost" id="importUnitType" type="button" data-i18n="common.importExcel"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Импорт из Excel</button>
              <input type="file" id="importUnitTypeFile" accept=".xlsx,.xls" class="hidden" />
              <button class="btn" id="addUnitType" type="button" data-i18n="unitTypes.add">+ Добавить единицу</button>
            </div>
          </div>
          <section class="admin-panel">
            <div id="unitTypesList" class="unit-types-list"><div class="empty-admin">Загрузка…</div></div>
          </section>
        </div>

        <!-- ── VIEW: otdels (departments), with branch multi-assignment ── -->
        <div class="wrap hidden" id="viewOtdels">
          <div class="top">
            <div>
              <h1 data-i18n="otdels.title">Отделы</h1>
              <div class="sub" data-i18n="otdels.subtitle">Название на трёх языках и филиалы (branches), к которым привязан отдел</div>
            </div>
            <button class="btn" id="addOtdel" type="button" data-i18n="otdels.add">+ Добавить отдел</button>
          </div>
          <section class="admin-panel">
            <div id="otdelsList" class="unit-types-list"><div class="empty-admin">Загрузка…</div></div>
          </section>
        </div>

        <!-- ── VIEW: warehouses (sklad) ── -->
        <div class="wrap hidden" id="viewWarehouses">
          <div class="top">
            <div>
              <h1 data-i18n="warehouses.title">Склады</h1>
              <div class="sub" data-i18n="warehouses.subtitle">Склады и их привязка к филиалу</div>
            </div>
            <button class="btn" id="addWarehouse" type="button" data-i18n="warehouses.add">+ Добавить склад</button>
          </div>
          <section class="admin-panel">
            <div id="warehousesList" class="unit-types-list"><div class="empty-admin">Загрузка…</div></div>
          </section>
        </div>
        <!-- ── VIEW: branches (filialy) ── -->
        <div class="wrap hidden" id="viewBranches">
          <div class="top">
            <div>
              <h1 data-i18n="branches.title">Филиалы</h1>
              <div class="sub" data-i18n="branches.subtitle">Заводы/площадки холдинга — к ним привязываются отделы и склады</div>
            </div>
            <button class="btn" id="addBranch" type="button" data-i18n="branches.add">+ Добавить филиал</button>
          </div>
          <section class="admin-panel">
            <div id="branchesList" class="unit-types-list"><div class="empty-admin">Загрузка…</div></div>
          </section>
        </div>
      </section>
    </div>
    <!-- shared by every grid, so it lives outside the views (a hidden view would hide it) -->
    <div class="column-filter-popover hidden" id="columnFilterPopover" role="dialog" aria-modal="false" aria-label="Фильтр столбца"></div>
    <div id="toast" class="toast hidden"></div>
    <div id="confirmModal" class="modal-backdrop hidden">
      <div class="modal">
        <h2>Удалить строку?</h2>
        <p>Строка исчезнет из dashboard. История заявки останется в системе.</p>
        <div class="modal-actions">
          <button id="cancelDelete" class="btn ghost" type="button">Отмена</button>
          <button id="confirmDelete" class="btn" type="button">Удалить</button>
        </div>
      </div>
    </div>
    <datalist id="productCodeList"></datalist>
    <datalist id="productTitleList"></datalist>
    <div id="rowEditModal" class="modal-backdrop hidden">
      <form class="modal wide" id="rowEditForm">
        <h2 id="rowEditTitle">Редактировать строку</h2>
        <p id="rowEditSubtitle">Изменения сохранятся только после нажатия кнопки.</p>
        <input id="rowEditItemId" type="hidden" />
        <div class="row-edit-grid" id="rowEditFields"></div>
        <div class="err-line" id="rowEditErr"></div>
        <div class="modal-actions">
          <button class="btn ghost" id="rowEditCancel" type="button">Отмена</button>
          <button class="btn" id="rowEditSave" type="submit">Сохранить изменения</button>
        </div>
      </form>
    </div>
    <div id="accountModal" class="modal-backdrop hidden">
      <form class="modal wide" id="accountForm">
        <h2 id="accountTitle">Новый пользователь</h2>
        <p>Большинству сотрудников достаточно указать телефон — они работают через Telegram-бота. Логин и пароль нужны только тем, кому нужен вход в этот dashboard.</p>
        <input id="accountId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="accountName">Имя и фамилия</label><input class="fin" id="accountName" required /></div>
          <div class="modal-field"><label for="accountPosition">Должность</label><select class="fin" id="accountPosition"><option value="">Без должности</option></select></div>
          <div class="modal-field"><label for="accountUsername">Логин dashboard (необязательно, по умолчанию — телефон)</label><input class="fin" id="accountUsername" autocomplete="off" /></div>
          <div class="modal-field"><label for="accountPassword">Пароль для dashboard <span id="passwordHint"></span></label><input class="fin" id="accountPassword" type="password" autocomplete="new-password" /></div>
          <div class="modal-field"><label for="accountTelegram">Telegram ID</label><input class="fin" id="accountTelegram" inputmode="numeric" /></div>
          <div class="modal-field"><label for="accountEmail">Email</label><input class="fin" id="accountEmail" type="email" /></div>
          <div class="modal-field"><label for="accountPhone">Телефон</label><input class="fin" id="accountPhone" /></div>
          <div class="modal-field"><label for="accountStatus">Статус</label><select class="fin" id="accountStatus"><option value="active">Активен</option><option value="suspended">Приостановлен</option><option value="disabled">Отключён</option></select></div>
          <div class="modal-field full"><label data-i18n="people.departments">Отделы</label><div class="checkbox-list" id="accountDepartments"></div></div>
          <div class="modal-field full"><label for="accountRole">Добавить роль</label><select class="fin" id="accountRole"><option value="">Без новой роли</option></select></div>
          <div class="modal-field full hidden" id="currentRolesWrap"><label>Назначенные роли</label><div class="role-list" id="accountRoles"></div></div>
        </div>
        <div class="err-line" id="accountErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="accountCancel" type="button">Отмена</button><button class="btn" id="accountSave" type="submit">Создать пользователя</button></div>
      </form>
    </div>
    <div id="positionModal" class="modal-backdrop hidden">
      <form class="modal" id="positionForm">
        <h2 id="positionTitle">Новая должность</h2><input id="positionId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field full"><label for="positionNameRu">Название (RU)</label><input class="fin" id="positionNameRu" required /></div>
          <div class="modal-field full"><label for="positionNameUz">Название (UZ)</label><input class="fin" id="positionNameUz" required /></div>
          <div class="modal-field full"><label for="positionNameTr">Название (TR)</label><input class="fin" id="positionNameTr" required /></div>
        </div>
        <div class="err-line" id="positionErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="positionCancel" type="button">Отмена</button><button class="btn" id="positionSave" type="submit">Сохранить</button></div>
      </form>
    </div>
    <div id="roleModal" class="modal-backdrop hidden">
      <form class="modal wide" id="roleForm">
        <h2 id="roleTitle">Новая роль</h2>
        <p>Выберите только те действия, которые нужны сотруднику для работы.</p>
        <input id="roleId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="roleName">Название роли</label><input class="fin" id="roleName" required /></div>
          <div class="modal-field"><label for="roleCode">Код</label><input class="fin" id="roleCode" required /></div>
        </div>
        <div class="permission-groups" id="permissionGroups"></div>
        <div class="err-line" id="roleErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="roleCancel" type="button">Отмена</button><button class="btn" id="roleSave" type="submit">Сохранить роль</button></div>
      </form>
    </div>
    <div id="workflowModal" class="modal-backdrop hidden">
      <form class="modal" id="workflowForm">
        <h2>Новый workflow</h2>
        <p>Workflow будет сохранён как неактивный черновик.</p>
        <div class="modal-field"><label for="workflowName">Название</label><input class="fin" id="workflowName" required placeholder="Например: Закупка материалов" /></div>
        <div class="err-line" id="workflowErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="workflowCancel" type="button">Отмена</button><button class="btn" id="workflowSave" type="submit">Создать черновик</button></div>
      </form>
    </div>
    <div id="workflowStepModal" class="modal-backdrop hidden">
      <form class="modal wide" id="workflowStepForm">
        <h2 id="workflowStepTitle">Новый шаг</h2>
        <input id="workflowStepId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field full"><label for="workflowStepName">Название шага</label><input class="fin" id="workflowStepName" required /></div>
          <div class="modal-field"><label for="workflowStepKind">Действие</label><select class="fin" id="workflowStepKind"></select></div>
          <div class="modal-field"><label for="workflowStepRole">Ответственная роль</label><select class="fin" id="workflowStepRole"><option value="">Без роли</option></select></div>
          <div class="modal-field"><label for="workflowStepThreshold">Сумма от, UZS</label><input class="fin" id="workflowStepThreshold" type="number" min="0" placeholder="Без ограничения" /></div>
          <div class="modal-field"><label for="workflowStepRequestType">Только тип заявки</label><select class="fin" id="workflowStepRequestType"><option value="">Все типы</option><option value="material_request">Материал</option><option value="service_request">Услуга</option><option value="repair_request">Ремонт</option></select></div>
          <div class="modal-field full"><label for="workflowStepReject">Если отклонено</label><select class="fin" id="workflowStepReject"><option value="cancel">Отклонить заявку</option><option value="return_requester">Вернуть автору на доработку</option></select></div>
        </div>
        <div class="err-line" id="workflowStepErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="workflowStepCancel" type="button">Отмена</button><button class="btn" id="workflowStepSave" type="submit">Сохранить шаг</button></div>
      </form>
    </div>
    <div id="materialModal" class="modal-backdrop hidden">
      <form class="modal wide" id="materialForm">
        <h2 id="materialTitle">Новый товар</h2>
        <input id="materialId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="materialCode">Код товара</label><input class="fin" id="materialCode" required /></div>
          <div class="modal-field"><label for="materialUnit">Ед. изм.</label><select class="fin" id="materialUnit"></select></div>
          <div class="modal-field full"><label for="materialCategory">Категория</label><input class="fin" id="materialCategory" list="materialCategoryList" /><datalist id="materialCategoryList"></datalist></div>
          <div class="modal-field full"><label for="materialNameRu">Название (RU)</label><textarea class="fin auto-expand" id="materialNameRu" rows="1"></textarea></div>
          <div class="modal-field full"><label for="materialNameUz">Название (UZ)</label><textarea class="fin auto-expand" id="materialNameUz" rows="1"></textarea></div>
          <div class="modal-field full"><label for="materialNameTr">Название (TR, оригинал)</label><textarea class="fin auto-expand" id="materialNameTr" rows="1"></textarea></div>
        </div>
        <div class="err-line" id="materialErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="materialCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="materialSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="supplierModal" class="modal-backdrop hidden">
      <form class="modal wide" id="supplierForm">
        <h2 id="supplierTitle">Новый поставщик</h2>
        <input id="supplierId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="supplierName">Название</label><input class="fin" id="supplierName" required /></div>
          <div class="modal-field"><label for="supplierInn">ИНН</label><input class="fin" id="supplierInn" /></div>
          <div class="modal-field"><label for="supplierPhone">Телефон</label><input class="fin" id="supplierPhone" /></div>
          <div class="modal-field"><label for="supplierEmail">Email</label><input class="fin" id="supplierEmail" type="email" /></div>
          <div class="modal-field"><label for="supplierContact">Контактное лицо</label><input class="fin" id="supplierContact" /></div>
          <div class="modal-field"><label for="supplierCategory">Категория</label><input class="fin" id="supplierCategory" /></div>
          <div class="modal-field"><label for="supplierRating">Рейтинг (0–5)</label><input class="fin" id="supplierRating" type="number" min="0" max="5" step="0.1" /></div>
          <div class="modal-field full"><label for="supplierNote">Заметка</label><input class="fin" id="supplierNote" /></div>
        </div>
        <div class="err-line" id="supplierErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="supplierCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="supplierSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="unitTypeModal" class="modal-backdrop hidden">
      <form class="modal" id="unitTypeForm">
        <h2 id="unitTypeTitle">Новая единица</h2>
        <input id="unitTypeId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="unitTypeCode">Код</label><input class="fin" id="unitTypeCode" required /></div>
          <div class="modal-field"><label for="unitTypeNameRu">RU</label><input class="fin" id="unitTypeNameRu" required /></div>
          <div class="modal-field"><label for="unitTypeNameUz">UZ</label><input class="fin" id="unitTypeNameUz" /></div>
          <div class="modal-field"><label for="unitTypeNameTr">TR</label><input class="fin" id="unitTypeNameTr" /></div>
        </div>
        <div class="err-line" id="unitTypeErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="unitTypeCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="unitTypeSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="otdelModal" class="modal-backdrop hidden">
      <form class="modal" id="otdelForm">
        <h2 id="otdelTitle">Новый отдел</h2>
        <input id="otdelId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="otdelNameRu">RU</label><input class="fin" id="otdelNameRu" required /></div>
          <div class="modal-field"><label for="otdelNameUz">UZ</label><input class="fin" id="otdelNameUz" /></div>
          <div class="modal-field"><label for="otdelNameTr">TR</label><input class="fin" id="otdelNameTr" /></div>
          <div class="modal-field full"><label data-i18n="otdels.branches">Филиалы (branches)</label><div class="checkbox-list" id="otdelFactories"></div></div>
        </div>
        <div class="err-line" id="otdelErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="otdelCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="otdelSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="warehouseModal" class="modal-backdrop hidden">
      <form class="modal" id="warehouseForm">
        <h2 id="warehouseTitle">Новый склад</h2>
        <input id="warehouseId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field full"><label for="warehouseName">Название (RU)</label><input class="fin" id="warehouseName" required /></div>
          <div class="modal-field full"><label for="warehouseNameUz">Название (UZ)</label><input class="fin" id="warehouseNameUz" /></div>
          <div class="modal-field full"><label for="warehouseNameTr">Название (TR)</label><input class="fin" id="warehouseNameTr" /></div>
          <div class="modal-field full"><label for="warehouseFactory" data-i18n="warehouses.colBranch">Филиал</label><select class="fin" id="warehouseFactory"><option value="">—</option></select></div>
          <div class="modal-field full"><label for="warehouseResponsible" data-i18n="warehouses.responsible">Ответственный сотрудник</label><select class="fin" id="warehouseResponsible"><option value="">Не назначен</option></select></div>
        </div>
        <div class="err-line" id="warehouseErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="warehouseCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="warehouseSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="branchModal" class="modal-backdrop hidden">
      <form class="modal" id="branchForm">
        <h2 id="branchTitle">Новый филиал</h2>
        <input id="branchId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field full"><label for="branchName" data-i18n="branches.colName">Название</label><input class="fin" id="branchName" required /></div>
        </div>
        <div class="err-line" id="branchErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="branchCancel" type="button" data-i18n="common.cancel">Отмена</button><button class="btn" id="branchSave" type="submit" data-i18n="common.save">Сохранить</button></div>
      </form>
    </div>
    <div id="requestDetailModal" class="modal-backdrop hidden">
      <article class="modal detail-modal">
        <header class="detail-head"><div><div class="request-number" id="detailNumber">—</div><h2 id="detailTitle">Заявка</h2></div><button class="icon-close" id="detailClose" type="button" aria-label="Закрыть">×</button></header>
        <div class="detail-body" id="detailBody"><div class="empty-admin">Загрузка…</div></div>
      </article>
    </div>
    <div id="requestEditModal" class="modal-backdrop hidden">
      <form class="modal wide" id="requestEditForm">
        <h2>Редактировать заявку</h2>
        <p>Изменения будут видны и в dashboard, и в Telegram Web App.</p>
        <div class="modal-form-grid">
          <div class="modal-field full"><label for="requestEditTitle">Название заявки</label><input class="fin" id="requestEditTitle" required /></div>
          <div class="modal-field full"><label for="requestEditDescription">Комментарий</label><textarea class="fin" id="requestEditDescription" rows="3"></textarea></div>
          <div class="modal-field"><label for="requestEditPriority">Приоритет</label><select class="fin" id="requestEditPriority"><option value="low">Низкий</option><option value="normal">Обычный</option><option value="high">Срочный</option><option value="urgent">Аварийный</option><option value="critical">Критический</option></select></div>
          <div class="modal-field"><label for="requestEditNeededDate">Нужно к</label><input class="fin" id="requestEditNeededDate" type="date" /></div>
          <div class="modal-field full"><label for="requestEditWarehouse">Склад</label><input class="fin" id="requestEditWarehouse" /></div>
          <div class="modal-field full"><label>Позиции</label><div class="quote-item-fields" id="requestEditItems"></div><button class="mini" id="requestEditAddItem" type="button">+ Добавить позицию</button></div>
        </div>
        <div class="err-line" id="requestEditErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="requestEditCancel" type="button">Отмена</button><button class="btn" id="requestEditSave" type="submit">Сохранить изменения</button></div>
      </form>
    </div>
    <div id="actionModal" class="modal-backdrop hidden">
      <form class="modal wide" id="actionForm">
        <h2 id="actionTitle">Выполнить действие</h2>
        <p id="actionDescription">Проверьте данные перед продолжением.</p>
        <div class="action-fields" id="actionFields"></div>
        <div class="err-line" id="actionErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="actionCancel" type="button">Отмена</button><button class="btn" id="actionSubmit" type="submit">Продолжить</button></div>
      </form>
    </div>
  </main>
  <script>
    const headers = ${JSON.stringify(HEADERS)};
    const groups = ${JSON.stringify(GROUPS)};
    const keys = ${JSON.stringify(KEYS)};
    const editableKeys = new Set(${JSON.stringify([...EDITABLE_KEYS])});
    const defaultVisibleKeys = new Set(['date','object','requester','requestNumber','expenseArticle','materialName','unit','quantity','unitPrice','amount','paymentType','supplier','cfoReceiver']);
    let rows = [];
    let materials = [];
    let branches = [];
    let selectedBranch = localStorage.getItem('snab.branch') || 'all';
    let activeFilterKey = null;
    let filterDraft = new Set();
    let meta = null;
    const fmt = new Intl.NumberFormat('ru-RU');
    const money = (v) => fmt.format(Math.round(Number(v) || 0));
    const compactMoney = new Intl.NumberFormat('ru-RU', { notation:'compact', maximumFractionDigits:1 });
    const numericKeys = new Set(['quantity','unitPrice','exchangeRate','amount','usdAmount','ndsRate','amountWithNds','usdAmountWithNds']);
    let pendingDeleteRow = null;
    let editingRow = null;
    function normalizedProductCode(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU'); }
    function productByCode(value) {
      const code = normalizedProductCode(value);
      return code ? materials.find((item) => normalizedProductCode(item.code) === code) || null : null;
    }
    function productByTitle(value) {
      const title = normalizedProductCode(value);
      return title ? materials.find((item) => [item.title, item.titleUz, item.titleTr].some((candidate) => normalizedProductCode(candidate) === title)) || null : null;
    }
    function materialTitleFor(item) {
      return localized(item, 'title', 'titleUz', 'titleTr') || item.title;
    }
    function renderProductCodeList() {
      const list = document.getElementById('productCodeList');
      if (list) list.innerHTML = materials.filter((item) => item.code).map((item) => '<option value="' + esc(item.code) + '">' + esc(materialTitleFor(item)) + '</option>').join('');
      const titleList = document.getElementById('productTitleList');
      if (titleList) titleList.innerHTML = materials.map((item) => '<option value="' + esc(materialTitleFor(item)) + '">' + esc(item.code) + '</option>').join('');
    }
    /* ── i18n (RU/UZ/TR) ── */
    const DICT = {
      ru: {
        'nav.menu':'Меню','nav.dashboard':'Дашборд','nav.requests':'Заявки','nav.newRequest':'Новая заявка',
        'nav.operations':'Операции','nav.procurement':'Снабжение','nav.namenklatura':'Номенклатура','nav.suppliers':'Поставщики',
        'nav.manage':'Настройки','settings.title':'Настройки','settings.subtitle':'Справочники, структура, доступ и маршруты Factory OS','nav.positions':'Должности','nav.people':'Пользователи','nav.roles':'Роли и права','nav.workflow':'Workflow','nav.unitTypes':'Единицы измерения','nav.logout':'Выйти',
        'positions.title':'Должности','positions.subtitle':'Единый справочник должностей на RU, UZ и TR для корректного i18n','positions.add':'+ Добавить должность',
        'branch.all':'Все филиалы',
        'overview.title':'Операционный дашборд','overview.searchPlaceholder':'Поиск заявок, документов, поставщиков...',
        'people.title':'Пользователи','people.subtitle':'Одна учётная запись для dashboard и Telegram Web App',
        'people.add':'+ Добавить пользователя','people.statTotal':'Всего пользователей','people.statWeb':'Доступ к dashboard',
        'people.statTelegram':'Связаны с Telegram','people.panelTitle':'Команда и доступ','people.searchPlaceholder':'Поиск по имени или логину…','people.departments':'Отделы',
        'roles.title':'Роли и права','roles.subtitle':'Системные роли едины для dashboard и Telegram; собственные роли можно настраивать',
        'roles.add':'+ Новая роль',
        'namenklatura.title':'Номенклатура','namenklatura.subtitle':'Код, название на трёх языках, категория и единица измерения',
        'namenklatura.add':'+ Добавить товар','namenklatura.colCode':'Код','namenklatura.colNameRu':'Название (RU)',
        'namenklatura.colNameUz':'Название (UZ)','namenklatura.colNameTr':'Название (TR)','namenklatura.colCategory':'Категория',
        'namenklatura.colUnit':'Ед. изм.','namenklatura.colActions':'',
        'suppliers.title':'Поставщики','suppliers.subtitle':'Контакты, категория и рейтинг поставщиков',
        'suppliers.add':'+ Добавить поставщика','suppliers.colName':'Название','suppliers.colInn':'ИНН','suppliers.colPhone':'Телефон',
        'suppliers.colEmail':'Email','suppliers.colContact':'Контактное лицо','suppliers.colCategory':'Категория','suppliers.colRating':'Рейтинг',
        'unitTypes.title':'Единицы измерения','unitTypes.subtitle':'Управляемый список — используется в заявках и номенклатуре',
        'unitTypes.add':'+ Добавить единицу','unitTypes.colCode':'Код','unitTypes.colNameRu':'RU','unitTypes.colNameUz':'UZ','unitTypes.colNameTr':'TR',
        'nav.otdels':'Отделы','nav.warehouses':'Склады',
        'otdels.title':'Отделы','otdels.subtitle':'Название на трёх языках и филиалы (branches), к которым привязан отдел','otdels.add':'+ Добавить отдел','otdels.branches':'Филиалы',
        'warehouses.title':'Склады','warehouses.subtitle':'Склады, филиалы и ответственные сотрудники','warehouses.add':'+ Добавить склад','warehouses.colName':'Название','warehouses.colBranch':'Филиал','warehouses.responsible':'Ответственный сотрудник',
        'nav.branches':'Филиалы','branches.title':'Филиалы','branches.subtitle':'Заводы/площадки холдинга — к ним привязываются отделы и склады','branches.add':'+ Добавить филиал','branches.colName':'Название',
        'common.cancel':'Отмена','common.save':'Сохранить','common.loading':'Загрузка…','common.empty':'Ничего не найдено',
        'common.importExcel':'Импорт из Excel',
        'grid.autofit':'По содержимому','grid.resetWidth':'Ширина по умолчанию','grid.clearFilters':'Сбросить фильтры',
        'grid.searchPlaceholder':'Поиск по таблице…',
      },
      uz: {
        'nav.menu':'Menyu','nav.dashboard':'Boshqaruv paneli','nav.requests':'Arizalar','nav.newRequest':'Yangi ariza',
        'nav.operations':'Operatsiyalar','nav.procurement':'Ta’minot','nav.namenklatura':'Nomenklatura','nav.suppliers':'Yetkazib beruvchilar',
        'nav.manage':'Sozlamalar','settings.title':'Sozlamalar','settings.subtitle':'Factory OS ma’lumotnomalari, tuzilmasi, kirish huquqlari va marshrutlari','nav.positions':'Lavozimlar','nav.people':'Foydalanuvchilar','nav.roles':'Rollar va huquqlar','nav.workflow':'Workflow','nav.unitTypes':'O‘lchov birligi','nav.logout':'Chiqish',
        'positions.title':'Lavozimlar','positions.subtitle':'To‘g‘ri i18n uchun RU, UZ va TR tillaridagi yagona lavozimlar ro‘yxati','positions.add':'+ Lavozim qo‘shish',
        'branch.all':'Barcha filiallar',
        'overview.title':'Operatsion boshqaruv paneli','overview.searchPlaceholder':'Ariza, hujjat, yetkazib beruvchi qidirish...',
        'people.title':'Foydalanuvchilar','people.subtitle':'Dashboard va Telegram Web App uchun bitta hisob',
        'people.add':'+ Foydalanuvchi qo‘shish','people.statTotal':'Jami foydalanuvchilar','people.statWeb':'Dashboard kirishi',
        'people.statTelegram':'Telegram bilan bog‘langan','people.panelTitle':'Jamoa va kirish huquqlari','people.searchPlaceholder':'Ism yoki login bo‘yicha qidirish…','people.departments':'Bo‘limlar',
        'roles.title':'Rollar va huquqlar','roles.subtitle':'Tizim rollari dashboard va Telegram uchun umumiy; o‘z rollaringizni sozlashingiz mumkin',
        'roles.add':'+ Yangi rol',
        'namenklatura.title':'Nomenklatura','namenklatura.subtitle':'Kod, uch tildagi nomi, kategoriya va o‘lchov birligi',
        'namenklatura.add':'+ Mahsulot qo‘shish','namenklatura.colCode':'Kod','namenklatura.colNameRu':'Nomi (RU)',
        'namenklatura.colNameUz':'Nomi (UZ)','namenklatura.colNameTr':'Nomi (TR)','namenklatura.colCategory':'Kategoriya',
        'namenklatura.colUnit':'O‘lchov birligi','namenklatura.colActions':'',
        'suppliers.title':'Yetkazib beruvchilar','suppliers.subtitle':'Kontaktlar, kategoriya va reyting',
        'suppliers.add':'+ Yetkazib beruvchi qo‘shish','suppliers.colName':'Nomi','suppliers.colInn':'STIR','suppliers.colPhone':'Telefon',
        'suppliers.colEmail':'Email','suppliers.colContact':'Kontakt shaxs','suppliers.colCategory':'Kategoriya','suppliers.colRating':'Reyting',
        'unitTypes.title':'O‘lchov birliklari','unitTypes.subtitle':'Boshqariladigan ro‘yxat — arizalar va nomenklaturada ishlatiladi',
        'unitTypes.add':'+ Birlik qo‘shish','unitTypes.colCode':'Kod','unitTypes.colNameRu':'RU','unitTypes.colNameUz':'UZ','unitTypes.colNameTr':'TR',
        'nav.otdels':'Bo‘limlar','nav.warehouses':'Omborlar',
        'otdels.title':'Bo‘limlar','otdels.subtitle':'Uch tilda nomi va bo‘lim biriktirilgan filiallar','otdels.add':'+ Bo‘lim qo‘shish','otdels.branches':'Filiallar',
        'warehouses.title':'Omborlar','warehouses.subtitle':'Omborlar, filiallar va mas’ul xodimlar','warehouses.add':'+ Ombor qo‘shish','warehouses.colName':'Nomi','warehouses.colBranch':'Filial','warehouses.responsible':'Mas’ul xodim',
        'nav.branches':'Filiallar','branches.title':'Filiallar','branches.subtitle':'Xolding zavodlari — bo‘limlar va omborlar shularga bog‘lanadi','branches.add':'+ Filial qo‘shish','branches.colName':'Nomi',
        'common.cancel':'Bekor qilish','common.save':'Saqlash','common.loading':'Yuklanmoqda…','common.empty':'Hech narsa topilmadi',
        'common.importExcel':'Excel dan import',
        'grid.autofit':'Mazmun bo‘yicha','grid.resetWidth':'Standart kenglik','grid.clearFilters':'Filtrlarni tozalash',
        'grid.searchPlaceholder':'Jadval bo‘yicha qidiruv…',
      },
      tr: {
        'nav.menu':'Menü','nav.dashboard':'Panel','nav.requests':'Talepler','nav.newRequest':'Yeni talep',
        'nav.operations':'İşlemler','nav.procurement':'Tedarik','nav.namenklatura':'Ürün listesi','nav.suppliers':'Tedarikçiler',
        'nav.manage':'Ayarlar','settings.title':'Ayarlar','settings.subtitle':'Factory OS listeleri, yapısı, erişimi ve iş akışları','nav.positions':'Pozisyonlar','nav.people':'Kullanıcılar','nav.roles':'Roller ve izinler','nav.workflow':'Workflow','nav.unitTypes':'Birim','nav.logout':'Çıkış',
        'positions.title':'Pozisyonlar','positions.subtitle':'Doğru i18n için RU, UZ ve TR dillerinde ortak pozisyon listesi','positions.add':'+ Pozisyon ekle',
        'branch.all':'Tüm şubeler',
        'overview.title':'Operasyon paneli','overview.searchPlaceholder':'Talep, belge, tedarikçi ara...',
        'people.title':'Kullanıcılar','people.subtitle':'Dashboard ve Telegram Web App için tek hesap',
        'people.add':'+ Kullanıcı ekle','people.statTotal':'Toplam kullanıcı','people.statWeb':'Dashboard erişimi',
        'people.statTelegram':'Telegram’a bağlı','people.panelTitle':'Ekip ve erişim','people.searchPlaceholder':'İsim veya kullanıcı adına göre ara…','people.departments':'Departmanlar',
        'roles.title':'Roller ve izinler','roles.subtitle':'Sistem rolleri dashboard ve Telegram için ortaktır; kendi rollerinizi tanımlayabilirsiniz',
        'roles.add':'+ Yeni rol',
        'namenklatura.title':'Ürün listesi','namenklatura.subtitle':'Kod, üç dilde ad, kategori ve birim',
        'namenklatura.add':'+ Ürün ekle','namenklatura.colCode':'Kod','namenklatura.colNameRu':'Ad (RU)',
        'namenklatura.colNameUz':'Ad (UZ)','namenklatura.colNameTr':'Ad (TR)','namenklatura.colCategory':'Kategori',
        'namenklatura.colUnit':'Birim','namenklatura.colActions':'',
        'suppliers.title':'Tedarikçiler','suppliers.subtitle':'İletişim, kategori ve puan',
        'suppliers.add':'+ Tedarikçi ekle','suppliers.colName':'Ad','suppliers.colInn':'Vergi No','suppliers.colPhone':'Telefon',
        'suppliers.colEmail':'E-posta','suppliers.colContact':'İlgili kişi','suppliers.colCategory':'Kategori','suppliers.colRating':'Puan',
        'unitTypes.title':'Birimler','unitTypes.subtitle':'Yönetilen liste — taleplerde ve ürün listesinde kullanılır',
        'unitTypes.add':'+ Birim ekle','unitTypes.colCode':'Kod','unitTypes.colNameRu':'RU','unitTypes.colNameUz':'UZ','unitTypes.colNameTr':'TR',
        'nav.otdels':'Departmanlar','nav.warehouses':'Depolar',
        'otdels.title':'Departmanlar','otdels.subtitle':'Uc dilde ad ve departmanin bagli oldugu subeler','otdels.add':'+ Departman ekle','otdels.branches':'Subeler',
        'warehouses.title':'Depolar','warehouses.subtitle':'Depolar, şubeler ve sorumlu çalışanlar','warehouses.add':'+ Depo ekle','warehouses.colName':'Ad','warehouses.colBranch':'Sube','warehouses.responsible':'Sorumlu çalışan',
        'nav.branches':'Subeler','branches.title':'Subeler','branches.subtitle':'Holdingin fabrikalari — departmanlar ve depolar bunlara baglanir','branches.add':'+ Sube ekle','branches.colName':'Ad',
        'common.cancel':'İptal','common.save':'Kaydet','common.loading':'Yükleniyor…','common.empty':'Sonuç bulunamadı',
        'common.importExcel':'Excel dosyasindan aktar',
        'grid.autofit':'Icerige gore','grid.resetWidth':'Varsayilan genislik','grid.clearFilters':'Filtreleri temizle',
        'grid.searchPlaceholder':'Tabloda ara…',
      },
    };
    const SNAB_DRAFT_KEY = 'snab.langSwitchDraft';
    function currentLang() { return localStorage.getItem('snab.lang') || 'ru'; }
    function t(key) { return (DICT[currentLang()] && DICT[currentLang()][key]) || DICT.ru[key] || key; }
    // Entities with RU/UZ/TR name fields carry all three from the server — the
    // server has no idea which language the viewer has selected (it only lives
    // in localStorage), so localization always happens here, at render time.
    function localized(entity, ruKey, uzKey, trKey) {
      if (!entity) return null;
      const lang = currentLang();
      if (lang === 'uz' && entity[uzKey]) return entity[uzKey];
      if (lang === 'tr' && entity[trKey]) return entity[trKey];
      return entity[ruKey];
    }
    function deptNameFor(row) {
      // A manually-typed department name (no departmentId link) wins if present —
      // matches the precedence the rest of the app already uses for this field.
      return row.departmentName || localized(row, 'departmentNameResolved', 'departmentNameUz', 'departmentNameTr') || null;
    }
    function applyI18n() {
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    }
    function activeViewName() {
      const active = document.querySelector('.side-link[data-view].active');
      return active ? active.dataset.view : 'overview';
    }
    function saveSnabLanguageDraft(nextLang) {
      const draft = { nextLang, view: activeViewName(), form: null };
      if (draft.view === 'create') {
        draft.form = {
          state: form,
          fields: {
            requester: document.getElementById('fRequester')?.value || '',
            department: document.getElementById('fDepartment')?.value || '',
            object: document.getElementById('fObject')?.value || '',
            warehouse: document.getElementById('fWarehouse')?.value || '',
            purpose: document.getElementById('fPurpose')?.value || '',
            needed: document.getElementById('fNeeded')?.value || '',
            comment: document.getElementById('fComment')?.value || '',
          },
        };
      }
      sessionStorage.setItem(SNAB_DRAFT_KEY, JSON.stringify(draft));
    }
    function restoreCreateDraft() {
      let draft = null;
      try { draft = JSON.parse(sessionStorage.getItem(SNAB_DRAFT_KEY) || 'null'); } catch { draft = null; }
      if (!draft || draft.view !== 'create' || !draft.form) return;
      const saved = draft.form;
      if (saved.state && typeof saved.state === 'object') {
        form.type = saved.state.type || form.type;
        form.origin = saved.state.origin || form.origin;
        form.priority = saved.state.priority || form.priority;
        form.items = Array.isArray(saved.state.items) && saved.state.items.length ? saved.state.items : form.items;
        form.step = Math.max(1, Math.min(3, Number(saved.state.step) || 1));
      }
      renderItems();
      const fields = saved.fields || {};
      if (fields.requester) document.getElementById('fRequester').value = fields.requester;
      syncRequesterDepartment(fields.department || '');
      document.getElementById('fObject').value = fields.object || '';
      document.getElementById('fWarehouse').value = fields.warehouse || '';
      document.getElementById('fPurpose').value = fields.purpose || '';
      document.getElementById('fNeeded').value = fields.needed || '';
      document.getElementById('fComment').value = fields.comment || '';
      for (const c of document.getElementById('typeGrid').children) c.classList.toggle('selected', c.dataset.type === form.type);
      for (const c of document.getElementById('originPills').children) c.classList.toggle('sel-plain', c.dataset.origin === form.origin);
      syncUrgency();
      syncMaterialOnly();
      syncCreateStep();
      sessionStorage.removeItem(SNAB_DRAFT_KEY);
    }
    function restoreLanguageDraftView() {
      let draft = null;
      try { draft = JSON.parse(sessionStorage.getItem(SNAB_DRAFT_KEY) || 'null'); } catch { draft = null; }
      if (!draft || !draft.view) return false;
      showView(draft.view);
      if (draft.view !== 'create') sessionStorage.removeItem(SNAB_DRAFT_KEY);
      return true;
    }
    function setLang(lang, options = {}) {
      localStorage.setItem('snab.lang', lang);
      document.getElementById('langLabel').textContent = ({ru:'RU',uz:'UZ',tr:'TR'})[lang] || 'RU';
      document.querySelectorAll('[data-lang]').forEach((item) => item.classList.toggle('active', item.dataset.lang === lang));
      if (options.reload) {
        saveSnabLanguageDraft(lang);
        location.reload();
        return;
      }
      applyI18n();
      renderBranchSwitcher();
      // Names resolved server-side (otdel, product) carry all three languages —
      // re-render whatever's already on screen so the switch is immediate,
      // not just on the next reload/reopen.
      if (typeof requestsLoaded !== 'undefined' && requestsLoaded) renderRequests();
      if (typeof currentRequest !== 'undefined' && currentRequest) renderRequestDetail();
      if (typeof namenklaturaLoaded !== 'undefined' && namenklaturaLoaded) renderNamenklatura();
      if (typeof otdelsLoaded !== 'undefined' && otdelsLoaded) renderOtdels();
      if (typeof rows !== 'undefined' && rows.length) render();
    }

    let session = null;
    const TOKEN_KEY = 'snab_dashboard_token';
    function token() { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; }
    function setToken(value) {
      sessionStorage.setItem(TOKEN_KEY, value);
      localStorage.setItem(TOKEN_KEY, value);
    }
    function clearToken() {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    }
    class ApiError extends Error {
      constructor(message, status) {
        super(message);
        this.status = status;
      }
    }
    function authHeaders() {
      const value = token();
      return {'Content-Type':'application/json', ...(value ? {Authorization:'Bearer ' + value} : {})};
    }
    function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    // Textareas styled to look like a single-line input (auto-expand.fin) grow
    // with their content instead of scrolling — used for long product titles.
    function autoExpand(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
    document.addEventListener('input', (event) => {
      if (event.target.matches && event.target.matches('textarea.auto-expand')) autoExpand(event.target);
    });
    async function api(path, body) {
      const res = await fetch('/snab-dashboard/api/' + path, {
        method:'POST', headers:authHeaders(), body: JSON.stringify(body || {}),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 401) clearToken();
      if (!res.ok) throw new ApiError(out.error || 'Ошибка запроса', res.status);
      return out;
    }
    async function loginAccount(username, password) {
      const res = await fetch('/snab-dashboard/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password}),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(out.error || 'Ошибка входа', res.status);
      return out;
    }
    async function coreApi(path, method = 'GET', body) {
      const res = await fetch('/api' + path, {
        method, headers:authHeaders(), ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(out.error || 'Ошибка запроса', res.status);
      return out;
    }
    async function coreApiUpload(path, file) {
      const value = token();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api' + path, {
        method: 'POST', headers: value ? {Authorization:'Bearer ' + value} : {}, body: form,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(out.error || 'Ошибка импорта', res.status);
      return out;
    }
    function wireExcelImport(buttonId, fileInputId, apiPath, onDone) {
      const btn = document.getElementById(buttonId);
      const input = document.getElementById(fileInputId);
      if (!btn || !input) return;
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        btn.disabled = true;
        try {
          const out = await coreApiUpload(apiPath, file);
          toast('Импорт: добавлено ' + out.created + ', обновлено ' + out.updated + (out.skipped ? ', пропущено ' + out.skipped : ''));
          await onDone();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Не удалось импортировать файл');
        } finally {
          btn.disabled = false;
        }
      });
    }
    function hasPermission(...codes) {
      return codes.some((code) => session && session.permissions.includes(code));
    }
    function applyAccess() {
      const canView = hasPermission('requests.view','requests.view_own');
      const canCreate = hasPermission('requests.create');
      const canPeople = hasPermission('users.view','users.manage');
      const canManagePeople = hasPermission('users.manage');
      const canRoles = hasPermission('roles.manage');
      const canWorkflow = hasPermission('workflows.manage');
      const canManageSettings = hasPermission('settings.manage');
      const canManageMaterials = hasPermission('settings.manage','materials.manage');
      const canViewMaterials = hasPermission('warehouse.view','settings.manage','materials.manage');
      const canViewSuppliers = hasPermission('suppliers.view','suppliers.manage');
      const canManageSuppliers = hasPermission('suppliers.manage');
      document.getElementById('navOverview').classList.toggle('hidden', !canView);
      document.getElementById('navRequests').classList.toggle('hidden', !canView);
      document.getElementById('navProcurement').classList.toggle('hidden', !canView);
      document.getElementById('navNamenklatura').classList.toggle('hidden', !canViewMaterials);
      document.getElementById('navSuppliers').classList.toggle('hidden', !canViewSuppliers);
      document.querySelector('[data-view="create"]').classList.toggle('hidden', !canCreate);
      document.getElementById('settingsToggle').classList.toggle('hidden', !canPeople && !canRoles && !canWorkflow && !canManageSettings && !canViewMaterials);
      document.getElementById('navPeople').classList.toggle('hidden', !canPeople);
      document.getElementById('navSettings').classList.toggle('hidden', !canManageSettings);
      document.getElementById('navPositions').classList.toggle('hidden', !canManageSettings);
      document.getElementById('navRoles').classList.toggle('hidden', !canRoles);
      document.getElementById('navWorkflow').classList.toggle('hidden', !canWorkflow);
      document.getElementById('navUnitTypes').classList.toggle('hidden', !canManageSettings);
      document.getElementById('navOtdels').classList.toggle('hidden', !canManageSettings);
      document.getElementById('navWarehouses').classList.toggle('hidden', !canManageSettings);
      document.getElementById('navBranches').classList.toggle('hidden', !canManageSettings);
      document.getElementById('addUser').classList.toggle('hidden', !canManagePeople);
      const isOwner = Array.isArray(session.roleCodes) && session.roleCodes.includes('owner');
      document.getElementById('addRole').classList.toggle('hidden', !isOwner);
      document.getElementById('deleteAllRequests').classList.toggle('hidden', !isOwner);
      document.getElementById('addMaterial').classList.toggle('hidden', !canManageMaterials);
      const importMaterialBtn = document.getElementById('importMaterial');
      if (importMaterialBtn) importMaterialBtn.classList.toggle('hidden', !canManageMaterials);
      document.getElementById('addSupplier').classList.toggle('hidden', !canManageSuppliers);
      document.getElementById('sideUserName').textContent = session.user.fullName;
      document.getElementById('sideUserLogin').textContent = '@' + session.user.username;
      document.getElementById('sideAvatar').textContent = initials(session.user.fullName);
    }
    async function enterApp() {
      session = await api('me');
      if (session.mustChangePassword) {
        document.getElementById('login').classList.add('hidden');
        document.getElementById('app').classList.add('hidden');
        document.getElementById('forcePasswordScreen').classList.remove('hidden');
        document.getElementById('forcePassword1').focus();
        return;
      }
      document.getElementById('forcePasswordScreen').classList.add('hidden');
      branches = session.branches || [];
      renderBranchSwitcher();
      applyAccess();
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      if (hasPermission('requests.view','requests.view_own')) {
        load().catch((err) => toast(err instanceof Error ? err.message : 'Не удалось загрузить данные'));
        refreshInboxCount();
      }
      let forcedView = null;
      if (!hasPermission('requests.view','requests.view_own')) {
        if (hasPermission('users.view','users.manage')) forcedView = 'people';
        else if (hasPermission('roles.manage')) forcedView = 'roles';
      }
      if (forcedView) showView(forcedView, { replace:true });
      else if (!restoreLanguageDraftView()) showView(viewFromLocation(), { replace:true });
    }

    // Topbar branch (filial) switcher: disabled when the user has 0-1 assigned
    // branches (nothing to switch between); otherwise a dropdown of their
    // assigned branches plus "all branches" (aggregated).
    function renderBranchSwitcher() {
      const btn = document.getElementById('factorySwitch');
      const menu = document.getElementById('factoryMenu');
      const label = document.getElementById('factoryLabel');
      if (branches.length <= 1) {
        btn.disabled = true;
        btn.classList.add('disabled');
        label.textContent = branches.length === 1 ? branches[0].name : t('branch.all');
        menu.innerHTML = '';
        return;
      }
      btn.disabled = false;
      btn.classList.remove('disabled');
      if (selectedBranch !== 'all' && !branches.some((b) => b.id === selectedBranch)) selectedBranch = 'all';
      const active = selectedBranch === 'all' ? null : branches.find((b) => b.id === selectedBranch);
      label.textContent = active ? active.name : t('branch.all');
      menu.innerHTML = '<button class="lang-option' + (selectedBranch === 'all' ? ' active' : '') + '" data-branch="all" type="button">' + esc(t('branch.all')) + '</button>' +
        branches.map((b) => '<button class="lang-option' + (selectedBranch === b.id ? ' active' : '') + '" data-branch="' + esc(b.id) + '" type="button">' + esc(b.name) + '</button>').join('');
    }
    // Rows whose factoryId falls outside the user's assigned branches never show,
    // even in "all" (aggregate) mode — "all" aggregates the user's own branches,
    // not the whole holding. Rows with no factoryId (legacy data) always show.
    function branchFilterOk(row) {
      if (!branches.length) return true;
      if (!row.factoryId) return true;
      if (selectedBranch === 'all') return branches.some((b) => b.id === row.factoryId);
      return row.factoryId === selectedBranch;
    }

    /* ── view switching (sidebar = navigation) ── */
    function closeSidebar() {
      document.body.classList.remove('sidebar-open');
      document.getElementById('menuToggle').setAttribute('aria-label', 'Открыть меню');
    }
    const SETTINGS_VIEWS = new Set(['settings', 'namenklatura', 'positions', 'people', 'roles', 'workflow', 'unitTypes', 'otdels', 'warehouses', 'branches']);
    const VIEW_PATHS = { overview:'overview', procurement:'procurement', requests:'requests', create:'create', settings:'settings', positions:'positions', people:'people', roles:'roles', workflow:'workflow', namenklatura:'namenklatura', suppliers:'suppliers', unitTypes:'unit-types', otdels:'departments', warehouses:'warehouses', branches:'branches' };
    const PATH_VIEWS = Object.fromEntries(Object.entries(VIEW_PATHS).map(([view, path]) => [path, view]));
    function viewFromLocation() {
      const prefix = '/snab-dashboard/';
      const path = (location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : '').split('/')[0];
      return PATH_VIEWS[path] || 'overview';
    }
    function setSettingsExpanded(expanded) {
      document.getElementById('settingsGroup').classList.toggle('collapsed', !expanded);
      document.getElementById('settingsToggle').setAttribute('aria-expanded', String(expanded));
      localStorage.setItem('snab.settingsExpanded', expanded ? '1' : '0');
    }
    function showView(view, options = {}) {
      const views = { overview:'viewOverview', procurement:'viewProcurement', requests:'viewRequests', create:'viewCreate', settings:'viewSettings', positions:'viewPositions', people:'viewPeople', roles:'viewRoles', workflow:'viewWorkflow', namenklatura:'viewNamenklatura', suppliers:'viewSuppliers', unitTypes:'viewUnitTypes', otdels:'viewOtdels', warehouses:'viewWarehouses', branches:'viewBranches' };
      if (!views[view]) view = 'overview';
      const nav = document.querySelector('.side-link[data-view="' + view + '"]');
      if (nav && nav.classList.contains('hidden')) view = 'overview';
      for (const [key, id] of Object.entries(views)) document.getElementById(id).classList.toggle('hidden', key !== view);
      const titleKeys = { settings:'settings.title', positions:'positions.title', people:'people.title', roles:'roles.title', namenklatura:'namenklatura.title', suppliers:'suppliers.title', unitTypes:'unitTypes.title', otdels:'otdels.title', warehouses:'warehouses.title', branches:'branches.title' };
      document.getElementById('navTitle').textContent = view === 'overview' ? '' : (titleKeys[view] ? t(titleKeys[view]) : ({ procurement:'Снабжение', requests:'Заявки и согласования', create:'Новая заявка' })[view] || 'Factory OS');
      for (const link of document.querySelectorAll('.side-link[data-view]')) {
        link.classList.toggle('active', link.dataset.view === view);
      }
      if (SETTINGS_VIEWS.has(view)) setSettingsExpanded(true);
      if (view === 'create') ensureMeta();
      if (view === 'requests') ensureRequests();
      if (view === 'people') ensurePeople();
      if (view === 'positions') ensurePositions();
      if (view === 'roles') ensureRoleData();
      if (view === 'workflow') ensureWorkflowData();
      if (view === 'procurement') { const table = document.getElementById('table'); autofitUntouched(table); syncGridWidth(table); }
      if (view === 'namenklatura') ensureNamenklatura();
      if (view === 'suppliers') ensureSuppliers();
      if (view === 'unitTypes') ensureUnitTypes();
      if (view === 'otdels') ensureOtdels();
      if (view === 'warehouses') ensureWarehouses();
      if (view === 'branches') ensureBranches();
      closeSidebar();
      applyI18n();
      if (options.history !== false) {
        const url = '/snab-dashboard/' + VIEW_PATHS[view];
        if (location.pathname !== url) history[options.replace ? 'replaceState' : 'pushState']({ view }, '', url);
      }
    }
    window.addEventListener('popstate', () => { if (session) showView(viewFromLocation(), { history:false }); });
    document.getElementById('settingsToggle').addEventListener('click', () => {
      setSettingsExpanded(document.getElementById('settingsGroup').classList.contains('collapsed'));
    });
    setSettingsExpanded(localStorage.getItem('snab.settingsExpanded') === '1');
    document.querySelectorAll('.side-link[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    document.querySelectorAll('[data-view-jump]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.viewJump)));
    // KPI cards jump to the view backing that number, preserving whatever
    // search/filter state produced it (Overview and Снабжение share the same
    // filtered rows) — gated by the same nav visibility the sidebar already uses.
    const KPI_JUMP_NAV = { requests: 'navRequests', procurement: 'navProcurement', suppliers: 'navSuppliers' };
    function jumpFromKpi(card) {
      const view = card.dataset.kpiJump;
      const navId = KPI_JUMP_NAV[view];
      if (navId && document.getElementById(navId).classList.contains('hidden')) return;
      if (card.dataset.kpiMode) {
        requestMode = card.dataset.kpiMode;
        document.querySelectorAll('[data-request-mode]').forEach((tab) => tab.classList.toggle('active', tab.dataset.requestMode === requestMode));
      }
      showView(view);
    }
    document.querySelectorAll('[data-kpi-jump]').forEach((card) => {
      card.addEventListener('click', () => jumpFromKpi(card));
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        jumpFromKpi(card);
      });
    });
    function showModulePreview(button) {
      const title = button.dataset.moduleTitle || 'Модуль';
      const note = button.dataset.moduleNote || 'Раздел будет открыт отдельным рабочим экраном.';
      toast(title + ': ' + note);
    }
    document.querySelectorAll('[data-module]').forEach((b) => b.addEventListener('click', () => showModulePreview(b)));
    document.getElementById('formCancel').addEventListener('click', () => {
      form.step = 1;
      syncCreateStep();
      showView('overview');
    });
    document.getElementById('createBack').addEventListener('click', () => {
      form.step = Math.max(1, form.step - 1);
      syncCreateStep();
    });
    document.getElementById('createNext').addEventListener('click', () => {
      if (!validateCreateStep(form.step)) return;
      form.step = Math.min(3, form.step + 1);
      syncCreateStep();
    });
    document.getElementById('factorySwitch').addEventListener('click', () => {
      if (branches.length <= 1) return;
      document.getElementById('factoryMenu').classList.toggle('hidden');
    });
    document.getElementById('factoryMenu').addEventListener('click', (event) => {
      const button = event.target.closest('[data-branch]');
      if (!button) return;
      selectedBranch = button.dataset.branch;
      localStorage.setItem('snab.branch', selectedBranch);
      document.getElementById('factoryMenu').classList.add('hidden');
      renderBranchSwitcher();
      render();
      if (requestsLoaded) ensureRequests(true);
    });
    document.getElementById('notifyButton').addEventListener('click', () => showView('requests'));
    document.getElementById('langToggle').addEventListener('click', () => document.getElementById('langMenu').classList.toggle('hidden'));
    document.querySelectorAll('[data-lang]').forEach((button) => button.addEventListener('click', () => {
      setLang(button.dataset.lang, { reload: true });
      document.getElementById('langMenu').classList.add('hidden');
    }));
    function syncThemeIcon() {
      const icon = document.getElementById('themeIcon');
      const isLight = document.body.dataset.theme === 'light';
      icon.className = 'ti ' + (isLight ? 'ti-moon' : 'ti-sun');
      document.getElementById('themeToggle').title = isLight ? 'Тёмная тема' : 'Светлая тема';
    }
    document.getElementById('themeToggle').addEventListener('click', () => {
      const light = document.body.dataset.theme !== 'light';
      document.body.dataset.theme = light ? 'light' : 'dark';
      localStorage.setItem('snab_dashboard_theme', document.body.dataset.theme);
      syncThemeIcon();
    });
    document.body.dataset.theme = localStorage.getItem('snab_dashboard_theme') || 'light';
    syncThemeIcon();

    /* ── overview: search / filters / table ── */
    /* ── Excel-style column filter popover, shared by every grid ──
       A grid provides: { id, filters, labelOf(key), valuesFor(key), onChange(), sortBy(key,dir) } */
    let activeFilterGrid = null;
    function normalizedCell(value) { return String(value ?? '').trim().toLocaleLowerCase('ru-RU'); }
    function filterOptionsFor(grid, key) {
      const found = new Map();
      for (const value of grid.valuesFor(key)) {
        const raw = String(value ?? '').trim();
        const normalized = raw.toLocaleLowerCase('ru-RU');
        if (!found.has(normalized)) found.set(normalized, raw);
      }
      return [...found.entries()]
        .map(([value, label]) => ({ value, label: label || '(Пусто)' }))
        .sort((a,b) => a.label.localeCompare(b.label, 'ru', { numeric:true, sensitivity:'base' }));
    }
    function matchesColumnFilter(value, filter) {
      const cell = normalizedCell(value);
      if (filter.mode === 'empty') return !cell;
      if (filter.mode === 'filled') return !!cell;
      if (!filter.values || !filter.values.length) return true;
      if (filter.mode === 'contains') return filter.values.some((needle) => cell.includes(needle));
      return filter.values.includes(cell);
    }
    function closeColumnFilter() {
      activeFilterKey = null;
      activeFilterGrid = null;
      document.getElementById('columnFilterPopover').classList.add('hidden');
    }
    function activeFilterOptions() {
      if (!activeFilterGrid || !activeFilterKey) return [];
      return filterOptionsFor(activeFilterGrid, activeFilterKey);
    }
    function renderColumnFilterValues(query = '') {
      if (!activeFilterKey) return;
      const needle = query.trim().toLocaleLowerCase('ru-RU');
      const values = activeFilterOptions().filter((option) => !needle || option.label.toLocaleLowerCase('ru-RU').includes(needle));
      document.getElementById('columnFilterValues').innerHTML = values.length ? values.map((option) =>
        '<label class="column-filter-value"><input type="checkbox" data-filter-value="' + esc(option.value) + '"' + (filterDraft.has(option.value) ? ' checked' : '') + '><span title="' + esc(option.label) + '">' + esc(option.label) + '</span></label>'
      ).join('') : '<div class="filter-empty" style="padding:12px 5px">Ничего не найдено.</div>';
    }
    function openColumnFilter(grid, key, button) {
      activeFilterGrid = grid;
      activeFilterKey = key;
      const allValues = activeFilterOptions().map((option) => option.value);
      const current = grid.filters[key];
      filterDraft = current ? new Set(current.values || []) : new Set(allValues);
      const popover = document.getElementById('columnFilterPopover');
      popover.innerHTML =
        '<div class="column-filter-head"><strong>' + esc(grid.labelOf(key)) + '</strong><button type="button" data-filter-command="close" aria-label="Закрыть"><i class="ti ti-x"></i></button></div>' +
        (grid.sortBy ? '<div class="column-filter-sort"><button type="button" data-filter-command="sort-asc"><i class="ti ti-arrow-up"></i> По возрастанию</button><button type="button" data-filter-command="sort-desc"><i class="ti ti-arrow-down"></i> По убыванию</button></div>' : '') +
        '<label class="column-filter-search"><i class="ti ti-search"></i><input id="columnFilterSearch" placeholder="Поиск значений..." autocomplete="off"></label>' +
        '<div class="column-filter-tools"><button type="button" data-filter-command="all">Выбрать все</button><button type="button" data-filter-command="none">Снять все</button></div>' +
        '<div class="column-filter-values" id="columnFilterValues"></div>' +
        '<div class="column-filter-actions"><button class="mini" type="button" data-filter-command="clear">Очистить</button><button class="btn" type="button" data-filter-command="apply">Применить</button></div>';
      popover.classList.remove('hidden');
      renderColumnFilterValues();
      const rect = button.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - popover.offsetWidth - 12, rect.right - popover.offsetWidth));
      let top = rect.bottom + 7;
      if (top + popover.offsetHeight > window.innerHeight - 12) top = Math.max(12, rect.top - popover.offsetHeight - 7);
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      document.getElementById('columnFilterSearch').focus();
    }
    function applyColumnFilter() {
      if (!activeFilterGrid || !activeFilterKey) return;
      const grid = activeFilterGrid;
      const key = activeFilterKey;
      const allValues = activeFilterOptions().map((option) => option.value);
      if (!filterDraft.size || filterDraft.size === allValues.length) delete grid.filters[key];
      else grid.filters[key] = { mode:'in', values:[...filterDraft] };
      closeColumnFilter();
      grid.onChange();
    }
    function parseDateLike(value) {
      const text = String(value || '').trim();
      const match = text.match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
      if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? null : parsed;
    }
    function toast(message) {
      const el = document.getElementById('toast');
      if (!el) return;
      el.textContent = message;
      el.classList.remove('hidden');
      clearTimeout(window.__snabToast);
      window.__snabToast = setTimeout(() => el.classList.add('hidden'), 3000);
    }
    function renderDashboardDate() {
      const date = new Date().toLocaleDateString('ru-RU', { weekday:'long', day:'numeric', month:'long' });
      document.getElementById('dashboardDate').textContent = 'Zelal Textile · ' + date;
    }
    function groupedByDay(data) {
      const days = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
      const out = days.map((day) => ({ day, created:0, approved:0, closed:0 }));
      for (const row of data) {
        const parsed = new Date(row.date || row.createdAt || Date.now());
        const index = Number.isNaN(parsed.getTime()) ? 0 : (parsed.getDay() + 6) % 7;
        out[index].created += 1;
        if (row.supplier) out[index].approved += 1;
        if (row.contractNumber || row.contractDate) out[index].closed += 1;
      }
      return out;
    }
    function renderPipeline(data) {
      const stages = [
        {label:'Заявки', note:'Всего позиций', value:data.length, tone:''},
        {label:'Контекст готов', note:'Объект и склад', value:data.filter((row) => row.object && row.warehouse).length, tone:'done'},
        {label:'Поставщик выбран', note:'Можно оформлять', value:data.filter((row) => row.supplier).length, tone:'done'},
        {label:'Документы готовы', note:'Есть договор', value:data.filter((row) => row.contractNumber).length, tone:'warn'},
      ];
      document.getElementById('pipelineBars').innerHTML = stages.map((stage) =>
        '<div class="rail-stage ' + stage.tone + '"><span class="rail-node"></span><div class="rail-value">' + fmt.format(stage.value) + '</div><div class="rail-label">' + stage.label + '</div><div class="rail-note">' + stage.note + '</div></div>'
      ).join('');
    }
    function renderCompactPanels(data) {
      const missing = data.filter((row) => !row.warehouse || !row.supplier || !row.contractNumber).slice(0, 4);
      document.getElementById('recentActivity').innerHTML = data.slice(0, 4).map((row) =>
        '<div class="compact-row"><div><strong>' + esc(row.requestNumber || 'Заявка') + '</strong><br><span>' + esc(row.materialName || row.requester || 'Обновлена строка') + '</span></div><span>' + esc(row.date || '—') + '</span></div>'
      ).join('') || '<div class="compact-row"><span>Событий пока нет</span></div>';
      const budget = [
        ['Снабжение', data.reduce((sum, row) => sum + Number(row.amount || 0), 0), 100000000],
        ['Заполненность', data.length - missing.length, Math.max(1, data.length)],
        ['Документы', data.filter((row) => row.contractNumber).length, Math.max(1, data.length)],
      ];
      document.getElementById('budgetBars').innerHTML = budget.map(([label, actual, limit]) => {
        const pct = Math.min(100, Math.round(Number(actual) / Number(limit) * 100));
        return '<div class="compact-row"><div style="width:100%"><strong>' + esc(label) + '</strong><div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div></div><span>' + pct + '%</span></div>';
      }).join('');
    }
    function renderOpsDashboard(data) {
      renderDashboardDate();
      renderPipeline(data);
      renderCompactPanels(data);
    }
    async function load() {
      const body = await api('data');
      rows = body.rows || [];
      materials = body.materials || materials;
      renderProductCodeList();
      document.getElementById('updated').textContent = 'Обновлено: ' + new Date().toLocaleString('ru-RU');
      render();
    }
    /* With table-layout:fixed the column widths are the layout, so the table's own
       min-width has to follow them — otherwise the browser stretches the columns back. */
    function syncGridWidth(table) {
      if (!table) return;
      const total = [...table.querySelectorAll('col')].reduce((sum, col) => sum + (parseFloat(col.style.width) || 0), 0);
      table.style.minWidth = Math.max(720, Math.round(total)) + 'px';
    }
    const moneyKeys = new Set(['unitPrice', 'amount', 'usdAmount', 'amountWithNds', 'usdAmountWithNds']);
    function moneyHidden(key) { return moneyKeys.has(key) && session && session.canSeeMoney === false; }
    /* The register runs on the same grid component as Номенклатура and Поставщики —
       it just adds column groups, KPI updates, search, and money masking. */
    let procurementGrid = null;
    function registerGrid() {
      // built on first use: the shared grid kit is defined further down this script
      if (!procurementGrid) procurementGrid = createDataGrid(PROCUREMENT_GRID);
      return procurementGrid;
    }
    const PROCUREMENT_GRID = {
      tableId: 'table',
      hostId: 'procurementHost',
      groups,
      defaultVisible: [...defaultVisibleKeys],
      defaultSortKey: 'date',
      defaultSortDir: 'desc',
      emptyText: 'Нет строк под выбранные фильтры',
      columns: keys.map((key, index) => ({
        key,
        label: headers[index] || key,
        width: 126,
        numeric: numericKeys.has(key),
        text: (row) => {
          if (moneyHidden(key)) return '—';
          if (!numericKeys.has(key)) return String(row[key] ?? '');
          return money(String(Math.round(Number(row[key]) || 0)));
        },
      })),
      cellTitle: (row, column, shown) => (moneyHidden(column.key) ? 'Скрыта' : shown),
      // rows carry more fields than the visible columns, so search scans the whole row
      searchRow: (row, query) => JSON.stringify(row).toLowerCase().includes(query),
      rowFilter: (row) => branchFilterOk(row),
      rowAttrs: (row) => 'data-item-id="' + esc(row.itemId) + '"',
      source: () => rows,
      actions: () => {
        const edit = hasPermission('procurement.quote','requests.edit','settings.manage') ? '<button class="icon-action" type="button" title="Редактировать" data-action="edit"><i class="ti ti-pencil" aria-hidden="true"></i></button>' : '';
        const del = hasPermission('requests.edit','settings.manage') ? '<button class="icon-action danger" type="button" title="Удалить" data-action="delete"><i class="ti ti-trash" aria-hidden="true"></i></button>' : '';
        return edit + del;
      },
      onRender: (data) => {
        const kRows = document.getElementById('kRows');
        const kRequests = document.getElementById('kRequests');
        const kSuppliers = document.getElementById('kSuppliers');
        if (kRows) kRows.textContent = fmt.format(data.length);
        if (kRequests) kRequests.textContent = fmt.format(new Set(data.map((r) => r.requestNumber).filter(Boolean)).size);
        const amountKpi = document.getElementById('kAmount');
        if (amountKpi) {
          if (session && session.canSeeMoney === false) {
            amountKpi.textContent = 'Скрыта';
            amountKpi.title = 'Нет прав на просмотр сумм';
          } else {
            const totalAmount = data.reduce((sum, r) => sum + Number(r.amount || 0), 0);
            amountKpi.textContent = Math.abs(totalAmount) >= 1000000000 ? compactMoney.format(totalAmount) : money(totalAmount);
            amountKpi.title = money(totalAmount) + ' UZS';
          }
        }
        if (kSuppliers) kSuppliers.textContent = fmt.format(new Set(data.map((r) => r.supplier).filter(Boolean)).size);
        renderOpsDashboard(data);
      },
    };
    function render() { registerGrid().render(); }
    function rowPayloadFromModal() {
      const out = {};
      for (const input of document.querySelectorAll('[data-row-edit-key]')) {
        const key = input.dataset.rowEditKey;
        const raw = input.value.trim();
        out[key] = numericKeys.has(key) ? Number(raw.replace(/\\s/g, '').replace(',', '.')) || 0 : raw;
      }
      return out;
    }
    function rowEditField(row, key) {
      const index = keys.indexOf(key);
      const label = headers[index] || key;
      const value = row[key] ?? '';
      const input = numericKeys.has(key)
        ? '<input class="fin" data-row-edit-key="' + key + '" type="number" step="any" value="' + esc(String(value ?? 0)) + '" />'
        : '<input class="fin" data-row-edit-key="' + key + '"' + (key === 'productCode' ? ' list="productCodeList" autocomplete="off"' : '') + ' value="' + esc(String(value)) + '" />';
      return '<div class="modal-field"><label>' + esc(label) + '</label>' + input + '</div>';
    }
    function syncRowMaterialFromCode(codeInput) {
      const material = productByCode(codeInput.value);
      if (!material) return;
      codeInput.value = material.code;
      const title = materialTitleFor(material);
      const titleInput = document.querySelector('[data-row-edit-key="materialName"]');
      const unitInput = document.querySelector('[data-row-edit-key="unit"]');
      if (titleInput) titleInput.value = title;
      if (unitInput && material.unit) unitInput.value = material.unit;
      document.getElementById('rowEditSubtitle').textContent = title;
    }
    function openRowEdit(itemId) {
      const row = rows.find((item) => item.itemId === itemId);
      if (!row) { toast('Строка не найдена'); return; }
      editingRow = row;
      document.getElementById('rowEditItemId').value = row.itemId;
      document.getElementById('rowEditTitle').textContent = 'Редактировать строку ' + (row.requestNumber || '');
      document.getElementById('rowEditSubtitle').textContent = row.materialName || 'Проверьте данные перед сохранением.';
      document.getElementById('rowEditErr').textContent = '';
      document.getElementById('rowEditFields').innerHTML = [...editableKeys].map((key) => rowEditField(row, key)).join('');
      document.getElementById('rowEditModal').classList.remove('hidden');
    }
    document.getElementById('rowEditFields').addEventListener('input', (event) => {
      const input = event.target.closest('[data-row-edit-key="productCode"]');
      if (input) syncRowMaterialFromCode(input);
    });
    document.getElementById('rowEditFields').addEventListener('change', (event) => {
      const input = event.target.closest('[data-row-edit-key="productCode"]');
      if (input) syncRowMaterialFromCode(input);
    });
    function closeRowEdit() {
      editingRow = null;
      document.getElementById('rowEditModal').classList.add('hidden');
    }
    async function saveRowEdit() {
      const itemId = document.getElementById('rowEditItemId').value;
      const res = await fetch('/snab-dashboard/api/row/' + encodeURIComponent(itemId), {
        method:'PUT', headers:authHeaders(), body: JSON.stringify({ row: rowPayloadFromModal(), lang: currentLang() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Не удалось сохранить');
      closeRowEdit();
      await load();
      toast('Сохранено');
    }
    async function deleteRow(tr) {
      const res = await fetch('/snab-dashboard/api/row/' + encodeURIComponent(tr.dataset.itemId), {
        method:'DELETE', headers:authHeaders(), body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Не удалось удалить');
      await load();
      toast('Удалено');
    }

    /* ── canonical requests: one workflow shared with Telegram Web App ── */
    let requestRows = [];
    let inboxRows = [];
    let requestMode = 'all';
    let requestsLoaded = false;
    let currentRequest = null;
    let currentAction = null;
    const requestStatusLabels = {
      draft:'Черновик', pending_approval:'На согласовании', warehouse_check:'Проверка склада',
      procurement:'Снабжение', finance_payment:'Оплата', delivery:'Доставка', receiving:'Приёмка',
      approved:'Согласовано', closed:'Закрыто', rejected:'Отклонено', cancelled:'Отменено', needs_revision:'На доработке',
    };
    const priorityLabels = { low:'Низкий', normal:'Обычный', high:'Срочный', urgent:'Аварийный', critical:'Критический' };
    function dateText(value, withTime = false) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString('ru-RU', withTime ? {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'} : {day:'2-digit',month:'2-digit',year:'numeric'});
    }
    function requestStatus(row) { return row.statusLabel || requestStatusLabels[row.status] || row.status || '—'; }
    function setInboxCount() {
      const count = inboxRows.length;
      document.getElementById('inboxCount').textContent = count;
      document.getElementById('inboxBadge').textContent = count;
      document.getElementById('kInbox').textContent = fmt.format(count);
      document.getElementById('kInboxTrend').textContent = count ? 'Ожидают решения' : 'Очередь чистая';
      document.getElementById('notifyDot').classList.toggle('hidden', !count);
    }
    async function refreshInboxCount() {
      try { inboxRows = await coreApi('/requests/inbox?limit=200'); }
      catch { inboxRows = []; }
      setInboxCount();
      if (requestsLoaded && requestMode === 'inbox') renderRequests();
    }
    async function ensureRequests(force = false) {
      if (requestsLoaded && !force) return renderRequests();
      const list = document.getElementById('requestList');
      list.innerHTML = '<div class="empty-admin">Загрузка заявок…</div>';
      try {
        const branchQuery = selectedBranch !== 'all' ? '&factory_id=' + encodeURIComponent(selectedBranch) : '';
        const data = await Promise.all([coreApi('/requests?limit=200' + branchQuery), coreApi('/requests/inbox?limit=200')]);
        requestRows = data[0].items || [];
        inboxRows = data[1] || [];
        requestsLoaded = true;
        setInboxCount();
        renderRequests();
      } catch (err) {
        list.innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить заявки') + '</div>';
      }
    }
    function renderRequests() {
      const query = document.getElementById('requestSearch').value.trim().toLowerCase();
      const status = document.getElementById('requestStatus').value;
      const owner = Array.isArray(session.roleCodes) && session.roleCodes.includes('owner');
      const source = requestMode === 'inbox' ? inboxRows : requestRows;
      const data = source.filter((row) => {
        if (status && row.status !== status) return false;
        return !query || [row.requestNumber,row.title,row.requesterName,row.departmentName,row.departmentNameResolved,row.obyekt]
          .some((value) => String(value || '').toLowerCase().includes(query));
      });
      document.getElementById('requestList').innerHTML = data.map((row) => {
        const department = deptNameFor(row) || row.requesterName || 'Без отдела';
        const amount = row.estimatedAmount == null ? 'Сумма скрыта' : money(row.estimatedAmount) + ' UZS';
        const actions = Array.isArray(row.actions) && row.actions.length ? ' · ' + row.actions.length + ' действий' : '';
        return '<article class="request-row" data-request-id="' + esc(row.id) + '" tabindex="0">' +
          '<div><div class="request-number">' + esc(row.requestNumber || '—') + '</div><div class="request-title">' + esc(row.title || 'Без названия') + '</div><div class="request-meta">' + esc(department) + actions + '</div></div>' +
          '<div><span class="request-status">' + esc(requestStatus(row)) + '</span></div>' +
          '<div><div class="request-priority ' + esc(row.priority || 'normal') + '">' + esc(priorityLabels[row.priority] || row.priority || 'Обычный') + '</div><div class="request-meta">нужно к ' + esc(dateText(row.neededDate)) + '</div></div>' +
          '<div><div style="font-size:11.5px;font-weight:600">' + esc(amount) + '</div><div class="request-meta">' + esc(dateText(row.createdAt)) + '</div></div>' +
          (owner ? '<div class="request-row-actions"><button class="mini-action" type="button" data-edit-request="' + esc(row.id) + '">Редактировать</button><button class="mini-action danger" type="button" data-delete-request="' + esc(row.id) + '">Удалить</button></div>' : '<div class="request-arrow">›</div>') + '</article>';
      }).join('') || '<div class="empty-admin">' + (requestMode === 'inbox' ? 'Нет заявок, ожидающих вашего действия' : 'Заявки не найдены') + '</div>';
    }
    async function deleteCanonicalRequest(id) {
      const row = requestRows.find((item) => item.id === id) || inboxRows.find((item) => item.id === id);
      if (!confirm('Удалить заявку ' + ((row || {}).requestNumber || '') + '? Она исчезнет у пользователей, но останется в базе данных.')) return;
      try {
        await coreApi('/admin/requests/' + encodeURIComponent(id), 'DELETE');
        toast('Заявка удалена');
        requestsLoaded = false;
        await Promise.all([ensureRequests(true), load()]);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Не удалось удалить заявку');
      }
    }
    document.getElementById('deleteAllRequests').addEventListener('click', async () => {
      if (!confirm('Удалить все заявки? Они исчезнут у пользователей, но останутся в базе данных.')) return;
      const button = document.getElementById('deleteAllRequests');
      button.disabled = true;
      try {
        const result = await coreApi('/admin/requests/delete-all', 'POST', {});
        toast('Удалено заявок: ' + Number(result.deleted || 0));
        requestsLoaded = false;
        await Promise.all([ensureRequests(true), load()]);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Не удалось удалить заявки');
      } finally {
        button.disabled = false;
      }
    });
    document.querySelectorAll('[data-request-mode]').forEach((button) => button.addEventListener('click', () => {
      requestMode = button.dataset.requestMode;
      document.querySelectorAll('[data-request-mode]').forEach((tab) => tab.classList.toggle('active', tab === button));
      renderRequests();
    }));
    document.getElementById('requestSearch').addEventListener('input', renderRequests);
    document.getElementById('requestStatus').addEventListener('change', renderRequests);
    document.getElementById('requestList').addEventListener('click', (event) => {
      const editButton = event.target.closest('[data-edit-request]');
      if (editButton) {
        event.stopPropagation();
        openRequest(editButton.dataset.editRequest, true);
        return;
      }
      const deleteButton = event.target.closest('[data-delete-request]');
      if (deleteButton) {
        event.stopPropagation();
        deleteCanonicalRequest(deleteButton.dataset.deleteRequest);
        return;
      }
      const row = event.target.closest('[data-request-id]');
      if (row) openRequest(row.dataset.requestId);
    });
    document.getElementById('requestList').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-request-id]');
      if (row) { event.preventDefault(); openRequest(row.dataset.requestId); }
    });
    function detailCell(label, value) {
      return '<div class="detail-cell"><span>' + esc(label) + '</span><strong>' + esc(value || '—') + '</strong></div>';
    }
    async function openRequest(id, editAfterLoad = false) {
      const modal = document.getElementById('requestDetailModal');
      modal.classList.remove('hidden');
      document.getElementById('detailNumber').textContent = 'Загрузка…';
      document.getElementById('detailTitle').textContent = 'Заявка';
      document.getElementById('detailBody').innerHTML = '<div class="empty-admin">Загрузка…</div>';
      try {
        currentRequest = await coreApi('/requests/' + encodeURIComponent(id));
        renderRequestDetail();
        if (editAfterLoad) {
          if (currentRequest.canEdit) openRequestEdit();
          else toast('Эту заявку уже нельзя редактировать на текущем этапе');
        }
      } catch (err) {
        document.getElementById('detailBody').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось открыть заявку') + '</div>';
      }
    }
    function renderRequestDetail() {
      const row = currentRequest;
      if (!row) return;
      document.getElementById('detailNumber').textContent = row.requestNumber || '—';
      document.getElementById('detailTitle').textContent = row.title || 'Без названия';
      const mayStock = (row.actions || []).some((action) => ['wh_in_stock','wh_out_of_stock','wh_partial'].includes(action.action));
      const items = (row.items || []).map((item, index) => {
        const selectedIn = item.status === 'in_stock';
        const selectedOut = item.status === 'out_of_stock';
        const stock = mayStock ? '<div class="stock-choice"><button type="button" data-stock-item="' + esc(item.id) + '" data-stock="true" class="' + (selectedIn ? 'selected' : '') + '">Есть</button><button type="button" data-stock-item="' + esc(item.id) + '" data-stock="false" class="out ' + (selectedOut ? 'selected' : '') + '">Нет</button></div>' : esc(selectedIn ? 'В наличии' : selectedOut ? 'Нет в наличии' : '—');
        const price = item.totalAmount == null ? '—' : money(item.totalAmount) + ' UZS';
        const unitLabel = item.unit || item.unitName || '';
        const receivedQty = Number(item.receivedQty || 0);
        const orderedQty = Number(item.quantity || 0);
        const received = receivedQty <= 0
          ? '—'
          : '<span style="color:' + (receivedQty < orderedQty ? 'var(--amber)' : 'var(--green)') + '">' + esc(receivedQty + ' из ' + orderedQty + (unitLabel ? ' ' + unitLabel : '')) + '</span>';
        return '<tr><td>' + (index + 1) + '</td><td><strong>' + esc(item.name || item.itemName || '—') + '</strong><div class="request-meta">' + esc(item.code || item.itemCode || '') + '</div></td><td>' + esc(String(orderedQty) + ' ' + unitLabel) + '</td><td>' + esc(price) + '</td><td>' + received + '</td><td>' + stock + '</td></tr>';
      }).join('');
      const custom = (row.customInfo || []).length ? '<section class="detail-section"><div class="detail-section-title">Дополнительно</div><div class="detail-summary">' + row.customInfo.map((item) => detailCell(item.label,item.value)).join('') + '</div></section>' : '';
      const quotes = (row.quotations || []).length ? '<section class="detail-section"><div class="detail-section-title">Коммерческие предложения</div><div class="quote-list">' + row.quotations.map((quote) => '<div class="quote-card ' + (quote.selected ? 'selected' : '') + '"><div><strong>' + esc(quote.supplierName || 'Поставщик не указан') + '</strong><div class="request-meta">' + esc(quote.paymentType || '') + '</div></div><div><strong>' + esc(money(quote.amount) + ' UZS') + '</strong>' + (quote.selected ? '<div class="request-meta">Выбрано</div>' : '') + '</div></div>').join('') + '</div></section>' : '';
      const timeline = (row.workflowTimeline || []).map((step) => '<div class="timeline-step ' + esc(step.state || 'future') + '"><span class="timeline-dot"></span><div><div class="timeline-name">' + esc(step.stepName || 'Этап') + '</div><div class="timeline-meta">' + esc([step.actorName,step.actorRole,dateText(step.at,true)].filter((value) => value && value !== '—').join(' · ') || (step.state === 'current' ? 'Текущий этап' : 'Ожидает')) + '</div>' + (step.comment ? '<div class="timeline-meta">«' + esc(step.comment) + '»</div>' : '') + '</div></div>').join('');
      const actions = (row.actions || []).map((action) => '<button class="action-btn ' + (/reject|return|cancel/.test(action.action) ? 'danger' : '') + '" type="button" data-request-action="' + esc(action.action) + '">' + esc(action.label) + '</button>').join('');
      const editAction = row.canEdit ? '<button class="action-btn" type="button" data-edit-current-request><i class="ti ti-edit"></i> Редактировать заявку</button>' : '';
      document.getElementById('detailBody').innerHTML =
        '<div class="detail-summary">' + detailCell('Статус',requestStatus(row)) + detailCell('Автор',row.requesterName) + detailCell('Отдел',deptNameFor(row)) + detailCell('Нужно к',dateText(row.neededDate)) + detailCell('Приоритет',priorityLabels[row.priority] || row.priority) + detailCell('Ответственный',row.responsibleName) + detailCell('Сумма',row.estimatedAmount == null ? 'Скрыта' : money(row.estimatedAmount) + ' UZS') + detailCell('Создана',dateText(row.createdAt,true)) + '</div>' +
        (row.description ? '<section class="detail-section"><div class="detail-section-title">Комментарий</div><div style="font-size:12px;color:var(--text-sec)">' + esc(row.description) + '</div></section>' : '') + custom +
        '<section class="detail-section"><div class="detail-section-title">Позиции</div><div style="overflow-x:auto"><table class="detail-items"><thead><tr><th>№</th><th>Наименование</th><th>Количество</th><th>Сумма</th><th>Получено</th><th>Склад</th></tr></thead><tbody>' + items + '</tbody></table></div></section>' + quotes +
        (timeline ? '<section class="detail-section"><div class="detail-section-title">Маршрут</div><div class="timeline">' + timeline + '</div></section>' : '') +
        '<div class="detail-actions">' + editAction + actions + (!editAction && !actions ? '<span class="request-meta">Доступных действий сейчас нет</span>' : '') + '</div>';
    }
    function requestEditItemHtml(item = {}) {
      return '<div class="quote-entry-line" data-request-edit-item data-item-id="' + esc(item.id || '') + '"><div class="quote-entry-controls" style="grid-template-columns:minmax(220px,2fr) minmax(90px,.7fr) minmax(100px,.8fr) auto">' +
        '<input class="fin" data-edit-item-name list="productTitleList" autocomplete="off" required placeholder="Название товара" value="' + esc(item.name || item.itemName || '') + '" />' +
        '<input class="fin" data-edit-item-quantity type="number" min="0.000001" step="any" required placeholder="Количество" value="' + esc(item.quantity || 1) + '" />' +
        '<input class="fin" data-edit-item-unit placeholder="Ед. изм." value="' + esc(item.unit || item.unitName || '') + '" />' +
        '<button class="mini danger" type="button" data-remove-edit-item aria-label="Удалить позицию">×</button></div></div>';
    }
    function openRequestEdit() {
      if (!currentRequest || !currentRequest.canEdit) return;
      document.getElementById('requestEditTitle').value = currentRequest.title || '';
      document.getElementById('requestEditDescription').value = currentRequest.description || '';
      document.getElementById('requestEditPriority').value = currentRequest.priority || 'normal';
      document.getElementById('requestEditNeededDate').value = currentRequest.neededDate ? String(currentRequest.neededDate).slice(0,10) : '';
      document.getElementById('requestEditNeededDate').min = new Date().toISOString().slice(0,10);
      document.getElementById('requestEditWarehouse').value = currentRequest.warehouseName || '';
      document.getElementById('requestEditItems').innerHTML = (currentRequest.items || []).map(requestEditItemHtml).join('') || requestEditItemHtml();
      document.getElementById('requestEditErr').textContent = '';
      document.getElementById('requestEditModal').classList.remove('hidden');
    }
    function closeRequestEdit() { document.getElementById('requestEditModal').classList.add('hidden'); }
    function closeRequestDetail() { document.getElementById('requestDetailModal').classList.add('hidden'); currentRequest = null; }
    document.getElementById('detailClose').addEventListener('click', closeRequestDetail);
    document.getElementById('requestDetailModal').addEventListener('click', (event) => { if (event.target.id === 'requestDetailModal') closeRequestDetail(); });
    document.getElementById('detailBody').addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-current-request]');
      if (editButton) { openRequestEdit(); return; }
      const actionButton = event.target.closest('[data-request-action]');
      if (actionButton) {
        const action = (currentRequest.actions || []).find((item) => item.action === actionButton.dataset.requestAction);
        if (action) openRequestAction(action);
        return;
      }
      const stockButton = event.target.closest('[data-stock-item]');
      if (!stockButton || !currentRequest) return;
      stockButton.disabled = true;
      try {
        await coreApi('/requests/' + encodeURIComponent(currentRequest.id) + '/items/' + encodeURIComponent(stockButton.dataset.stockItem) + '/stock', 'POST', {inStock:stockButton.dataset.stock === 'true'});
        currentRequest = await coreApi('/requests/' + encodeURIComponent(currentRequest.id));
        renderRequestDetail();
        toast('Наличие обновлено');
      } catch (err) { toast(err instanceof Error ? err.message : 'Ошибка'); stockButton.disabled = false; }
    });
    document.getElementById('requestEditCancel').addEventListener('click', closeRequestEdit);
    document.getElementById('requestEditModal').addEventListener('click', (event) => { if (event.target.id === 'requestEditModal') closeRequestEdit(); });
    document.getElementById('requestEditAddItem').addEventListener('click', () => {
      document.getElementById('requestEditItems').insertAdjacentHTML('beforeend', requestEditItemHtml());
    });
    document.getElementById('requestEditItems').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-edit-item]');
      if (!button) return;
      const rows = document.querySelectorAll('[data-request-edit-item]');
      if (rows.length <= 1) { document.getElementById('requestEditErr').textContent = 'В заявке должна остаться хотя бы одна позиция'; return; }
      button.closest('[data-request-edit-item]').remove();
    });
    document.getElementById('requestEditItems').addEventListener('change', (event) => {
      const input = event.target.closest('[data-edit-item-name]');
      if (!input) return;
      const material = productByTitle(input.value) || productByCode(input.value);
      if (!material) return;
      input.value = materialTitleFor(material);
      const unit = input.closest('[data-request-edit-item]').querySelector('[data-edit-item-unit]');
      if (material.unit) unit.value = material.unit;
    });
    document.getElementById('requestEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentRequest || !currentRequest.canEdit) return;
      const button = document.getElementById('requestEditSave');
      const error = document.getElementById('requestEditErr');
      error.textContent = '';
      button.disabled = true;
      try {
        const items = [...document.querySelectorAll('[data-request-edit-item]')].map((row) => ({
          id: row.dataset.itemId || undefined,
          name: row.querySelector('[data-edit-item-name]').value.trim(),
          quantity: Number(row.querySelector('[data-edit-item-quantity]').value),
          unit: row.querySelector('[data-edit-item-unit]').value.trim() || null,
        }));
        if (!items.length || items.some((item) => !item.name || !Number.isFinite(item.quantity) || item.quantity <= 0)) throw new Error('Проверьте название и количество каждой позиции');
        const id = currentRequest.id;
        await coreApi('/requests/' + encodeURIComponent(id), 'PUT', {
          title: document.getElementById('requestEditTitle').value.trim(),
          description: document.getElementById('requestEditDescription').value.trim(),
          priority: document.getElementById('requestEditPriority').value,
          neededDate: document.getElementById('requestEditNeededDate').value || null,
          warehouseName: document.getElementById('requestEditWarehouse').value.trim(),
          items,
        });
        currentRequest = await coreApi('/requests/' + encodeURIComponent(id));
        renderRequestDetail();
        closeRequestEdit();
        await ensureRequests(true);
        await load();
        toast('Заявка обновлена в dashboard и Web App');
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить заявку';
      } finally { button.disabled = false; }
    });
    function actionField(id, label, input, full = false) {
      return '<div class="modal-field ' + (full ? 'full' : '') + '"><label for="' + id + '">' + esc(label) + '</label>' + input + '</div>';
    }
    async function openRequestAction(action) {
      currentAction = action;
      const fields = [];
      document.getElementById('actionTitle').textContent = action.label;
      document.getElementById('actionDescription').textContent = 'Действие будет записано в истории заявки.';
      document.getElementById('actionErr').textContent = '';
      if (action.pin) fields.push(actionField('actionPin','PIN подписи','<input class="fin" id="actionPin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required />'));
      if (action.comment) fields.push(actionField('actionComment','Комментарий','<textarea class="fin" id="actionComment" required placeholder="Укажите причину…"></textarea>',true));
      if (action.amount && action.quote !== 'add') fields.push(actionField('actionAmount','Сумма, UZS','<input class="fin" id="actionAmount" type="number" min="0" required />'));
      if (action.assign) {
        fields.push(actionField('actionAssignee','Снабженец','<select class="fin" id="actionAssignee"><option value="">Загрузка…</option></select>',true));
      }
      if (action.quote === 'select') {
        fields.push(actionField('actionQuotation','Коммерческое предложение','<select class="fin" id="actionQuotation">' + (currentRequest.quotations || []).map((quote) => '<option value="' + esc(quote.id) + '">' + esc((quote.supplierName || 'Поставщик') + ' — ' + money(quote.amount) + ' UZS') + '</option>').join('') + '</select>',true));
      }
      if (action.quote === 'add') {
        fields.push(actionField('actionSupplier','Поставщик','<input class="fin" id="actionSupplier" required placeholder="Название компании" />'));
        fields.push('<div class="modal-field full"><label>Условия по каждой позиции</label><div class="quote-item-fields">' + (currentRequest.items || []).map((item) => '<div class="quote-entry-line" data-quote-line="' + esc(item.id) + '"><span class="quote-entry-name">' + esc(item.name || item.itemName || 'Позиция') + ' · ' + esc(item.quantity || 0) + ' ' + esc(item.unit || item.unitName || '') + '</span><div class="quote-entry-controls"><input class="fin" data-quote-price type="number" min="0" required placeholder="Цена, UZS" /><select class="fin" data-quote-payment><option>Перечисление</option><option>Наличные</option></select><label class="quote-entry-nds"><span>НДС</span><input data-quote-nds type="checkbox" /></label></div></div>').join('') + '</div></div>');
      }
      if (['receive_partial','receive_discrepancy'].includes(action.action)) {
        fields.push('<div class="modal-field full"><label>Фактически принято</label><div class="quote-item-fields">' + (currentRequest.items || []).map((item) => '<label><span>' + esc(item.name || item.itemName || 'Позиция') + ' · заказано ' + esc(item.quantity || 0) + '</span><input class="fin" data-receipt-item="' + esc(item.id) + '" type="number" min="0" max="' + esc(item.quantity || 0) + '" required value="' + esc(item.receivedQty || 0) + '" /></label>').join('') + '</div></div>');
      }
      document.getElementById('actionFields').innerHTML = fields.join('') || '<div class="detail-cell full"><span>Подтверждение</span><strong>Продолжить действие?</strong></div>';
      document.getElementById('actionModal').classList.remove('hidden');
      if (action.assign) {
        try {
          const data = await coreApi('/procurement/assignees');
          document.getElementById('actionAssignee').innerHTML = '<option value="">Выберите снабженца</option>' + (data.users || []).map((user) => '<option value="' + esc(user.id) + '">' + esc(user.fullName) + '</option>').join('');
        } catch (err) { document.getElementById('actionErr').textContent = err instanceof Error ? err.message : 'Ошибка'; }
      }
    }
    function closeRequestAction() { document.getElementById('actionModal').classList.add('hidden'); currentAction = null; }
    document.getElementById('actionCancel').addEventListener('click', closeRequestAction);
    document.getElementById('actionModal').addEventListener('click', (event) => { if (event.target.id === 'actionModal') closeRequestAction(); });
    document.getElementById('actionForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentAction || !currentRequest) return;
      const body = {action:currentAction.action};
      const pin = document.getElementById('actionPin');
      const comment = document.getElementById('actionComment');
      const amount = document.getElementById('actionAmount');
      const assignee = document.getElementById('actionAssignee');
      const quotation = document.getElementById('actionQuotation');
      if (pin) body.pin = pin.value.trim();
      if (comment) body.comment = comment.value.trim();
      if (amount) body.amount = Number(amount.value);
      if (assignee) body.assigneeId = assignee.value;
      if (quotation) body.quotationId = quotation.value;
      if (currentAction.quote === 'add') {
        const supplier = document.getElementById('actionSupplier').value.trim();
        const quoteItems = [...document.querySelectorAll('[data-quote-line]')].map((line) => ({
          itemId:line.dataset.quoteLine,
          unitPrice:Number(line.querySelector('[data-quote-price]').value),
          supplierName:supplier,
          paymentType:line.querySelector('[data-quote-payment]').value,
          ndsIncluded:line.querySelector('[data-quote-nds]').checked,
        }));
        body.supplierName = supplier;
        body.paymentType = quoteItems[0]?.paymentType || '';
        body.ndsIncluded = quoteItems.some((item) => item.ndsIncluded);
        body.quoteItems = quoteItems;
      }
      const receiptInputs = [...document.querySelectorAll('[data-receipt-item]')];
      if (receiptInputs.length) body.receipts = receiptInputs.map((input) => ({itemId:input.dataset.receiptItem,receivedQty:Number(input.value)}));
      const submit = document.getElementById('actionSubmit');
      const error = document.getElementById('actionErr');
      error.textContent = '';
      submit.disabled = true;
      try {
        const id = currentRequest.id;
        await coreApi('/requests/' + encodeURIComponent(id) + '/action', 'POST', body);
        closeRequestAction();
        currentRequest = await coreApi('/requests/' + encodeURIComponent(id));
        renderRequestDetail();
        await ensureRequests(true);
        toast('Действие выполнено');
      } catch (err) { error.textContent = err instanceof Error ? err.message : 'Не удалось выполнить действие'; }
      finally { submit.disabled = false; }
    });

    /* ── workflow draft designer: configuration only, never activates a chain ── */
    const workflowKinds = [
      ['approval','Согласование'],['warehouse_check','Проверка склада'],['procurement_intake','Принятие снабжением'],
      ['procurement','Поиск поставщика'],['price_approval','Проверка цены'],['finance_payment','Оплата'],
      ['ordering','Оформление заказа'],['delivery','Доставка'],['receiving','Приёмка'],['issue','Выдача'],['close','Закрытие'],
    ];
    let workflowDrafts = [];
    let workflowRoles = [];
    let selectedWorkflowId = '';
    let workflowsLoaded = false;
    function workflowKindLabel(kind) { return (workflowKinds.find((item) => item[0] === kind) || [kind,kind])[1]; }
    async function ensureWorkflowData(force = false) {
      if (workflowsLoaded && !force) return renderWorkflowDesigner();
      try {
        const results = await Promise.all([coreApi('/admin/workflows'), coreApi('/admin/roles').catch(() => [])]);
        workflowDrafts = results[0] || [];
        workflowRoles = results[1] || [];
        if (!workflowDrafts.some((workflow) => workflow.id === selectedWorkflowId)) {
          selectedWorkflowId = (workflowDrafts.find((workflow) => !workflow.isActive) || workflowDrafts[0] || {}).id || '';
        }
        workflowsLoaded = true;
        renderWorkflowDesigner();
      } catch (err) {
        document.getElementById('workflowList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить workflow') + '</div>';
      }
    }
    function renderWorkflowDesigner() {
      document.getElementById('workflowCount').textContent = workflowDrafts.length;
      document.getElementById('workflowList').innerHTML = workflowDrafts.map((workflow) =>
        '<button class="workflow-list-item ' + (workflow.id === selectedWorkflowId ? 'active' : '') + '" type="button" data-workflow-id="' + esc(workflow.id) + '">' +
        '<div class="workflow-list-name">' + esc(workflow.name) + '</div><div class="workflow-list-meta"><span>' + (workflow.steps || []).length + ' шагов</span><span>·</span><span style="color:' + (workflow.isActive ? 'var(--green)' : 'var(--text-muted)') + '">' + (workflow.isActive ? 'Системный · просмотр' : 'Черновик') + '</span></div></button>'
      ).join('') || '<div class="empty-admin">Создайте первый workflow</div>';
      renderWorkflowEditor();
    }
    function renderWorkflowEditor() {
      const workflow = workflowDrafts.find((item) => item.id === selectedWorkflowId);
      const host = document.getElementById('workflowEditor');
      if (!workflow) { host.innerHTML = '<div class="empty-admin">Выберите или создайте workflow</div>'; return; }
      const editable = !workflow.isActive;
      const roleNames = new Map(workflowRoles.map((role) => [role.id, role.name]));
      const steps = (workflow.steps || []).map((step, index, all) => {
        const conditions = [];
        if (step.thresholdAmount != null) conditions.push('от ' + money(step.thresholdAmount) + ' UZS');
        if (step.conditionRule && step.conditionRule.requestType) conditions.push(step.conditionRule.requestType);
        if (step.onReject === 'return_requester') conditions.push('возврат автору');
        const actions = editable ? '<div class="workflow-step-actions"><button class="icon-action" type="button" data-workflow-move="up" data-step-id="' + esc(step.id) + '" ' + (index === 0 ? 'disabled' : '') + ' title="Выше">↑</button><button class="icon-action" type="button" data-workflow-move="down" data-step-id="' + esc(step.id) + '" ' + (index === all.length - 1 ? 'disabled' : '') + ' title="Ниже">↓</button><button class="icon-action" type="button" data-workflow-edit-step="' + esc(step.id) + '" title="Редактировать"><i class="ti ti-pencil"></i></button><button class="icon-action danger" type="button" data-workflow-delete-step="' + esc(step.id) + '" title="Удалить"><i class="ti ti-trash"></i></button></div>' : '';
        return '<article class="workflow-step"><span class="workflow-step-order">' + (index + 1) + '</span><div><div class="workflow-step-name">' + esc(step.stepName) + '</div><div class="workflow-step-meta"><span>' + esc(workflowKindLabel(step.stepKind)) + '</span>' + (step.approverRoleId ? '<span>· ' + esc(roleNames.get(step.approverRoleId) || 'Роль') + '</span>' : '') + (conditions.length ? '<span>· ' + esc(conditions.join(' · ')) + '</span>' : '') + '</div></div>' + actions + '</article>';
      }).join('');
      host.innerHTML = '<div class="workflow-editor-head"><div><h2>' + esc(workflow.name) + '</h2><p>' + (editable ? 'Неактивный черновик — не влияет на заявки' : 'Текущий системный маршрут — только просмотр') + '</p></div>' + (editable ? '<button class="btn" type="button" data-workflow-add-step>+ Добавить шаг</button>' : '<span class="status-dot active">Активен</span>') + '</div>' + (!editable ? '<div class="workflow-readonly">Чтобы не менять текущую работу заявок, создайте новый workflow-черновик.</div>' : '') + '<div class="workflow-steps">' + (steps || '<div class="empty-admin">Шагов пока нет</div>') + '</div>';
    }
    function openWorkflowModal() {
      document.getElementById('workflowName').value = '';
      document.getElementById('workflowErr').textContent = '';
      document.getElementById('workflowModal').classList.remove('hidden');
      document.getElementById('workflowName').focus();
    }
    function closeWorkflowModal() { document.getElementById('workflowModal').classList.add('hidden'); }
    function openWorkflowStep(step) {
      const workflow = workflowDrafts.find((item) => item.id === selectedWorkflowId);
      if (!workflow || workflow.isActive) return;
      document.getElementById('workflowStepId').value = step ? step.id : '';
      document.getElementById('workflowStepTitle').textContent = step ? 'Редактировать шаг' : 'Новый шаг';
      document.getElementById('workflowStepName').value = step ? step.stepName : '';
      document.getElementById('workflowStepKind').innerHTML = workflowKinds.map((item) => '<option value="' + esc(item[0]) + '">' + esc(item[1]) + '</option>').join('');
      document.getElementById('workflowStepKind').value = step ? step.stepKind : 'approval';
      document.getElementById('workflowStepRole').innerHTML = '<option value="">Без роли</option>' + workflowRoles.map((role) => '<option value="' + esc(role.id) + '">' + esc(role.name) + '</option>').join('');
      document.getElementById('workflowStepRole').value = step && step.approverRoleId ? step.approverRoleId : '';
      document.getElementById('workflowStepThreshold').value = step && step.thresholdAmount != null ? step.thresholdAmount : '';
      document.getElementById('workflowStepRequestType').value = step && step.conditionRule ? step.conditionRule.requestType || '' : '';
      document.getElementById('workflowStepReject').value = step ? step.onReject || 'cancel' : 'cancel';
      document.getElementById('workflowStepErr').textContent = '';
      document.getElementById('workflowStepModal').classList.remove('hidden');
    }
    function closeWorkflowStep() { document.getElementById('workflowStepModal').classList.add('hidden'); }
    document.getElementById('addWorkflow').addEventListener('click', openWorkflowModal);
    document.getElementById('workflowCancel').addEventListener('click', closeWorkflowModal);
    document.getElementById('workflowModal').addEventListener('click', (event) => { if (event.target.id === 'workflowModal') closeWorkflowModal(); });
    document.getElementById('workflowForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const save = document.getElementById('workflowSave');
      const error = document.getElementById('workflowErr');
      save.disabled = true; error.textContent = '';
      try {
        const created = await coreApi('/admin/workflows', 'POST', {name:document.getElementById('workflowName').value.trim()});
        selectedWorkflowId = created.id;
        closeWorkflowModal();
        await ensureWorkflowData(true);
        toast('Workflow сохранён как черновик');
      } catch (err) { error.textContent = err instanceof Error ? err.message : 'Не удалось создать workflow'; }
      finally { save.disabled = false; }
    });
    document.getElementById('workflowList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-workflow-id]');
      if (!button) return;
      selectedWorkflowId = button.dataset.workflowId;
      renderWorkflowDesigner();
    });
    document.getElementById('workflowEditor').addEventListener('click', async (event) => {
      const workflow = workflowDrafts.find((item) => item.id === selectedWorkflowId);
      if (!workflow || workflow.isActive) return;
      if (event.target.closest('[data-workflow-add-step]')) { openWorkflowStep(null); return; }
      const edit = event.target.closest('[data-workflow-edit-step]');
      if (edit) { openWorkflowStep((workflow.steps || []).find((step) => step.id === edit.dataset.workflowEditStep)); return; }
      const remove = event.target.closest('[data-workflow-delete-step]');
      if (remove) {
        if (!confirm('Удалить этот шаг из workflow?')) return;
        try { await coreApi('/admin/workflows/' + encodeURIComponent(workflow.id) + '/steps/' + encodeURIComponent(remove.dataset.workflowDeleteStep), 'DELETE'); await ensureWorkflowData(true); toast('Шаг удалён'); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить шаг'); }
        return;
      }
      const move = event.target.closest('[data-workflow-move]');
      if (!move) return;
      const steps = [...(workflow.steps || [])];
      const index = steps.findIndex((step) => step.id === move.dataset.stepId);
      const target = move.dataset.workflowMove === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= steps.length) return;
      [steps[index],steps[target]] = [steps[target],steps[index]];
      try { await coreApi('/admin/workflows/' + encodeURIComponent(workflow.id) + '/steps/reorder', 'PUT', steps.map((step, order) => ({id:step.id,order_index:order + 1}))); await ensureWorkflowData(true); }
      catch (err) { toast(err instanceof Error ? err.message : 'Не удалось изменить порядок'); }
    });
    document.getElementById('workflowStepCancel').addEventListener('click', closeWorkflowStep);
    document.getElementById('workflowStepModal').addEventListener('click', (event) => { if (event.target.id === 'workflowStepModal') closeWorkflowStep(); });
    document.getElementById('workflowStepForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const workflow = workflowDrafts.find((item) => item.id === selectedWorkflowId);
      if (!workflow || workflow.isActive) return;
      const id = document.getElementById('workflowStepId').value;
      const thresholdRaw = document.getElementById('workflowStepThreshold').value;
      const requestType = document.getElementById('workflowStepRequestType').value;
      const payload = {name:document.getElementById('workflowStepName').value.trim(),step_kind:document.getElementById('workflowStepKind').value,approver_role_id:document.getElementById('workflowStepRole').value || null,threshold_amount:thresholdRaw === '' ? null : Number(thresholdRaw),condition_rule:requestType ? {requestType} : null,on_reject:document.getElementById('workflowStepReject').value,...(id ? {} : {order_index:(workflow.steps || []).length + 1})};
      const save = document.getElementById('workflowStepSave');
      const error = document.getElementById('workflowStepErr');
      save.disabled = true; error.textContent = '';
      try {
        const path = '/admin/workflows/' + encodeURIComponent(workflow.id) + '/steps' + (id ? '/' + encodeURIComponent(id) : '');
        await coreApi(path, id ? 'PUT' : 'POST', payload);
        closeWorkflowStep();
        await ensureWorkflowData(true);
        toast(id ? 'Шаг обновлён' : 'Шаг добавлен');
      } catch (err) { error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить шаг'; }
      finally { save.disabled = false; }
    });

    /* ── shared users, dashboard accounts, roles and permissions ── */
    let people = [];
    let positionsItems = [];
    let adminRoles = [];
    let permissionCatalog = [];
    let peopleLoaded = false;
    let rolesLoaded = false;
    function initials(name) {
      return String(name || '?').trim().split(/\s+/).slice(0,2).map((part) => part[0] || '').join('').toUpperCase();
    }
    function statusLabel(status) {
      return ({ active:'Активен', suspended:'Приостановлен', disabled:'Отключён', pending:'Ожидает' })[status] || status;
    }
    async function ensurePeople(force = false) {
      if (peopleLoaded && !force) return renderPeople();
      try {
        const tasks = [coreApi('/admin/users'), coreApi('/admin/positions')];
        if (hasPermission('roles.manage')) tasks.push(coreApi('/admin/roles'));
        const data = await Promise.all(tasks);
        people = data[0] || [];
        positionsItems = data[1] || [];
        if (data[2]) adminRoles = data[2];
        peopleLoaded = true;
        renderPeople();
      } catch (err) {
        document.getElementById('peopleList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить пользователей') + '</div>';
      }
    }
    function renderPeople() {
      const query = document.getElementById('peopleSearch').value.trim().toLowerCase();
      const filtered = people.filter((u) => !query || [u.fullName,u.username,u.telegramId,u.position,u.positionRef?.nameUz,u.positionRef?.nameTr].some((v) => String(v || '').toLowerCase().includes(query)));
      document.getElementById('usersTotal').textContent = people.length;
      document.getElementById('usersWeb').textContent = people.filter((u) => u.username).length;
      document.getElementById('usersTelegram').textContent = people.filter((u) => u.telegramId).length;
      const head = '<div class="people-row head"><span>Сотрудник</span><span>Каналы входа</span><span>Роли</span><span>Статус</span><span></span></div>';
      const body = filtered.map((u) => {
        const roles = (u.roles || []).map((r) => '<span class="role-chip">' + esc(r.roleCode || 'role') + '</span>').join('') || '<span class="identity-meta">Нет роли</span>';
        const channels = '<div class="identity-meta">' + (u.username ? '@' + esc(u.username) : 'Dashboard —') + '</div><div class="identity-meta">' + (u.telegramId ? 'TG ' + esc(u.telegramId) : 'Telegram —') + '</div>';
        const action = hasPermission('users.manage') ? '<button class="icon-action" type="button" title="Настроить" data-edit-user="' + esc(u.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' : '';
        return '<div class="people-row"><div class="identity"><span class="avatar">' + esc(initials(u.fullName)) + '</span><div style="min-width:0"><div class="identity-name">' + esc(u.fullName) + '</div><div class="identity-meta">' + esc(localized(u.positionRef, 'nameRu', 'nameUz', 'nameTr') || u.position || u.email || 'Без должности') + '</div></div></div><div>' + channels + '</div><div class="role-list">' + roles + '</div><span class="status-dot ' + (u.status === 'active' ? 'active' : '') + '">' + esc(statusLabel(u.status)) + '</span><div>' + action + '</div></div>';
      }).join('');
      document.getElementById('peopleList').innerHTML = head + (body || '<div class="empty-admin">Пользователи не найдены</div>');
    }
    function fillAccountRoles(user) {
      const select = document.getElementById('accountRole');
      select.innerHTML = '<option value="">Без новой роли</option>' + adminRoles.map((role) => '<option value="' + esc(role.id) + '">' + esc(role.name) + '</option>').join('');
      select.closest('.modal-field').classList.toggle('hidden', !hasPermission('roles.manage'));
      const wrap = document.getElementById('currentRolesWrap');
      const list = document.getElementById('accountRoles');
      const assigned = user ? (user.roles || []) : [];
      wrap.classList.toggle('hidden', !user || !assigned.length);
      list.innerHTML = assigned.map((role) => '<button class="role-chip" type="button" data-revoke="' + esc(role.assignmentId) + '" data-user="' + esc(user.id) + '" title="Снять роль">' + esc(role.roleCode || 'role') + ' ×</button>').join('');
    }
    async function openAccount(user) {
      const editing = Boolean(user);
      document.getElementById('accountId').value = user ? user.id : '';
      document.getElementById('accountTitle').textContent = editing ? 'Настроить пользователя' : 'Новый пользователь';
      document.getElementById('accountName').value = user ? user.fullName || '' : '';
      const positionSelect = document.getElementById('accountPosition');
      positionSelect.innerHTML = '<option value="">Без должности</option>' + positionsItems.filter((p) => p.status === 'active').map((p) => '<option value="' + esc(p.id) + '">' + esc(localized(p, 'nameRu', 'nameUz', 'nameTr')) + '</option>').join('');
      positionSelect.value = user ? user.positionId || '' : '';
      document.getElementById('accountUsername').value = user ? user.username || '' : '';
      document.getElementById('accountPassword').value = '';
      document.getElementById('accountTelegram').value = user ? user.telegramId || '' : '';
      document.getElementById('accountEmail').value = user ? user.email || '' : '';
      document.getElementById('accountPhone').value = user ? user.phone || '' : '';
      document.getElementById('accountStatus').value = user ? user.status || 'active' : 'active';
      document.getElementById('accountStatus').closest('.modal-field').classList.toggle('hidden', !editing);
      document.getElementById('passwordHint').textContent = editing ? '(оставьте пустым без изменения)' : '(необязательно — не нужен, если сотрудник работает только через Telegram-бота)';
      document.getElementById('accountSave').textContent = editing ? 'Сохранить изменения' : 'Создать пользователя';
      document.getElementById('accountErr').textContent = '';
      fillAccountRoles(user);
      const deptBox = document.getElementById('accountDepartments');
      deptBox.innerHTML = '<span class="identity-meta">Загрузка…</span>';
      document.getElementById('accountModal').classList.remove('hidden');
      document.getElementById('accountName').focus();
      try {
        const depts = await coreApi('/admin/departments');
        const selected = new Set(user ? user.departmentIds || [] : []);
        deptBox.innerHTML = depts.map((d) =>
          '<label><input type="checkbox" value="' + esc(d.id) + '" ' + (selected.has(d.id) ? 'checked' : '') + ' /><span>' + esc(d.name) + '</span></label>',
        ).join('') || '<span class="identity-meta">Нет отделов</span>';
      } catch { deptBox.innerHTML = '<span class="identity-meta">Не удалось загрузить отделы</span>'; }
    }
    function closeAccount() { document.getElementById('accountModal').classList.add('hidden'); }
    document.getElementById('peopleSearch').addEventListener('input', renderPeople);
    document.getElementById('addUser').addEventListener('click', () => openAccount(null));
    document.getElementById('accountCancel').addEventListener('click', closeAccount);
    document.getElementById('peopleList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-user]');
      if (button) openAccount(people.find((u) => u.id === button.dataset.editUser));
    });
    document.getElementById('accountRoles').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-revoke]');
      if (!button) return;
      button.disabled = true;
      try {
        await coreApi('/admin/users/' + encodeURIComponent(button.dataset.user) + '/assignments/' + encodeURIComponent(button.dataset.revoke), 'DELETE');
        toast('Роль снята');
        closeAccount();
        await ensurePeople(true);
      } catch (err) {
        document.getElementById('accountErr').textContent = err instanceof Error ? err.message : 'Не удалось снять роль';
        button.disabled = false;
      }
    });
    document.getElementById('accountForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('accountId').value;
      const password = document.getElementById('accountPassword').value;
      const data = {
        fullName:document.getElementById('accountName').value.trim(),
        positionId:document.getElementById('accountPosition').value || null,
        username:document.getElementById('accountUsername').value.trim(),
        telegramId:document.getElementById('accountTelegram').value.trim(),
        email:document.getElementById('accountEmail').value.trim(),
        phone:document.getElementById('accountPhone').value.trim(),
        departmentIds:[...document.querySelectorAll('#accountDepartments input:checked')].map((el) => el.value),
        ...(password ? {password} : {}),
        ...(id ? {status:document.getElementById('accountStatus').value} : {}),
      };
      const roleId = document.getElementById('accountRole').value;
      const save = document.getElementById('accountSave');
      const error = document.getElementById('accountErr');
      error.textContent = '';
      // Most staff only ever use the Telegram bot and never log into the dashboard —
      // a password is only required if they also need dashboard login. Phone/username/
      // Telegram ID (checked server-side too) is enough on its own for a bot-only hire.
      if (!id && password && password.length < 8) { error.textContent = 'Пароль должен содержать минимум 8 символов'; return; }
      if (!id && !password && !data.phone && !data.username && !data.telegramId) {
        error.textContent = 'Укажите телефон, логин или Telegram ID';
        return;
      }
      save.disabled = true;
      try {
        const user = id ? await coreApi('/admin/users/' + encodeURIComponent(id), 'PUT', data) : await coreApi('/admin/users', 'POST', data);
        if (roleId) await coreApi('/admin/users/' + encodeURIComponent(user.id) + '/roles', 'POST', {roleId});
        toast(id ? 'Пользователь обновлён' : 'Пользователь создан');
        closeAccount();
        await ensurePeople(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить пользователя';
      } finally { save.disabled = false; }
    });

    async function ensurePositions(force = false) {
      if (!force && positionsItems.length) return renderPositions();
      try { positionsItems = await coreApi('/admin/positions'); renderPositions(); }
      catch (err) { document.getElementById('positionsList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить должности') + '</div>'; }
    }
    function renderPositions() {
      const head = '<div class="unit-type-row head" style="grid-template-columns:1fr 1fr 1fr 76px"><span>RU</span><span>UZ</span><span>TR</span><span></span></div>';
      const body = positionsItems.map((p) => '<div class="unit-type-row" style="grid-template-columns:1fr 1fr 1fr 76px"><span>' + esc(p.nameRu) + '</span><span>' + esc(p.nameUz) + '</span><span>' + esc(p.nameTr) + '</span><div class="unit-type-actions"><button class="icon-action" type="button" data-edit-position="' + esc(p.id) + '" title="Изменить"><i class="ti ti-pencil"></i></button><button class="icon-action danger" type="button" data-delete-position="' + esc(p.id) + '" title="Удалить"><i class="ti ti-trash"></i></button></div></div>').join('');
      document.getElementById('positionsList').innerHTML = head + (body || '<div class="empty-admin">' + t('common.empty') + '</div>');
    }
    function openPosition(p) {
      document.getElementById('positionId').value = p ? p.id : '';
      document.getElementById('positionTitle').textContent = p ? 'Изменить должность' : 'Новая должность';
      document.getElementById('positionNameRu').value = p ? p.nameRu : '';
      document.getElementById('positionNameUz').value = p ? p.nameUz : '';
      document.getElementById('positionNameTr').value = p ? p.nameTr : '';
      document.getElementById('positionErr').textContent = '';
      document.getElementById('positionModal').classList.remove('hidden');
      document.getElementById('positionNameRu').focus();
    }
    function closePosition() { document.getElementById('positionModal').classList.add('hidden'); }
    document.getElementById('addPosition').addEventListener('click', () => openPosition(null));
    document.getElementById('positionCancel').addEventListener('click', closePosition);
    document.getElementById('positionsList').addEventListener('click', async (event) => {
      const edit = event.target.closest('[data-edit-position]');
      if (edit) return openPosition(positionsItems.find((p) => p.id === edit.dataset.editPosition));
      const remove = event.target.closest('[data-delete-position]');
      if (!remove || !confirm('Удалить эту должность?')) return;
      try { await coreApi('/admin/positions/' + encodeURIComponent(remove.dataset.deletePosition), 'DELETE'); await ensurePositions(true); peopleLoaded = false; toast('Должность удалена'); }
      catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
    });
    document.getElementById('positionForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('positionId').value;
      const payload = { nameRu:document.getElementById('positionNameRu').value.trim(), nameUz:document.getElementById('positionNameUz').value.trim(), nameTr:document.getElementById('positionNameTr').value.trim() };
      const save = document.getElementById('positionSave'); save.disabled = true; document.getElementById('positionErr').textContent = '';
      try { await coreApi('/admin/positions' + (id ? '/' + encodeURIComponent(id) : ''), id ? 'PUT' : 'POST', payload); closePosition(); await ensurePositions(true); peopleLoaded = false; toast(id ? 'Должность обновлена' : 'Должность добавлена'); }
      catch (err) { document.getElementById('positionErr').textContent = err instanceof Error ? err.message : 'Не удалось сохранить'; }
      finally { save.disabled = false; }
    });

    const moduleNames = {requests:'Заявки',approvals:'Согласования',warehouse:'Склад',procurement:'Снабжение',suppliers:'Поставщики',finance:'Финансы',admin:'Администрирование',audit:'Аудит',reports:'Отчёты'};
    async function ensureRoleData(force = false) {
      if (rolesLoaded && !force) return renderRoles();
      try {
        const data = await Promise.all([coreApi('/admin/roles'), coreApi('/admin/permissions')]);
        adminRoles = data[0] || [];
        permissionCatalog = data[1] || [];
        rolesLoaded = true;
        renderRoles();
      } catch (err) {
        document.getElementById('rolesGrid').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить роли') + '</div>';
      }
    }
    function renderRoles() {
      const canEditRoles = Array.isArray(session.roleCodes) && session.roleCodes.includes('owner');
      document.getElementById('rolesGrid').innerHTML = adminRoles.map((role) => {
        const perms = (role.permissions || []).slice(0,8).map((code) => '<span class="perm-chip">' + esc(code) + '</span>').join('');
        const actions = canEditRoles
          ? '<div class="role-actions">' + (role.isSystem ? '<span class="role-count">Системная</span>' : '') + '<button class="icon-action" type="button" title="Редактировать" data-edit-role="' + esc(role.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' + (role.isSystem ? '' : '<button class="icon-action danger" type="button" title="Удалить" data-delete-role="' + esc(role.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>') + '</div>'
          : '<span class="role-count">' + (role.isSystem ? 'Системная · просмотр' : 'Только просмотр') + '</span>';
        return '<article class="role-card"><div class="role-card-head"><div><h3>' + esc(role.name) + '</h3><div class="role-code">' + esc(role.code) + '</div></div>' + actions + '</div><div class="role-perms">' + (perms || '<span class="identity-meta">Нет разрешений</span>') + '</div><div class="identity-meta" style="margin-top:12px">' + (role.permissions || []).length + ' разрешений</div></article>';
      }).join('') || '<div class="empty-admin">Роли не найдены</div>';
    }
    function renderPermissionGroups(selected) {
      const grouped = {};
      for (const permission of permissionCatalog) (grouped[permission.module] ||= []).push(permission);
      document.getElementById('permissionGroups').innerHTML = Object.entries(grouped).map(([module, list]) => '<section class="permission-group"><div class="permission-group-title">' + esc(moduleNames[module] || module) + '</div><div class="permission-options">' + list.map((permission) => '<label class="permission-option"><input type="checkbox" data-permission="' + esc(permission.code) + '"' + (selected.has(permission.code) ? ' checked' : '') + '><span>' + esc(permission.name) + '</span></label>').join('') + '</div></section>').join('');
    }
    function openRole(role) {
      document.getElementById('roleId').value = role ? role.id : '';
      document.getElementById('roleTitle').textContent = role ? 'Редактировать роль' : 'Новая роль';
      document.getElementById('roleName').value = role ? role.name : '';
      document.getElementById('roleName').readOnly = Boolean(role && role.isSystem);
      document.getElementById('roleCode').value = role ? role.code : '';
      document.getElementById('roleCode').readOnly = Boolean(role);
      document.getElementById('roleErr').textContent = '';
      renderPermissionGroups(new Set(role ? role.permissions || [] : []));
      document.getElementById('roleModal').classList.remove('hidden');
      document.getElementById('roleName').focus();
    }
    function closeRole() { document.getElementById('roleModal').classList.add('hidden'); }
    document.getElementById('addRole').addEventListener('click', () => openRole(null));
    document.getElementById('roleCancel').addEventListener('click', closeRole);
    document.getElementById('rolesGrid').addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-role]');
      if (editButton) {
        openRole(adminRoles.find((role) => role.id === editButton.dataset.editRole));
        return;
      }
      const deleteButton = event.target.closest('[data-delete-role]');
      if (!deleteButton) return;
      const role = adminRoles.find((item) => item.id === deleteButton.dataset.deleteRole);
      if (!role || role.isSystem) return;
      if (!window.confirm('Удалить роль "' + role.name + '"? Если роль назначена пользователям или workflow, система не даст её удалить.')) return;
      deleteButton.disabled = true;
      try {
        await coreApi('/admin/roles/' + encodeURIComponent(role.id), 'DELETE');
        toast('Роль удалена');
        peopleLoaded = false;
        await ensureRoleData(true);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Не удалось удалить роль');
        deleteButton.disabled = false;
      }
    });
    document.getElementById('roleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('roleId').value;
      const name = document.getElementById('roleName').value.trim();
      const code = document.getElementById('roleCode').value.trim().toLowerCase();
      const codes = [...document.querySelectorAll('[data-permission]:checked')].map((input) => input.dataset.permission);
      const save = document.getElementById('roleSave');
      const error = document.getElementById('roleErr');
      error.textContent = '';
      save.disabled = true;
      try {
        let roleId = id;
        const existingRole = id ? adminRoles.find((role) => role.id === id) : null;
        if (id) {
          if (!existingRole?.isSystem) await coreApi('/admin/roles/' + encodeURIComponent(id), 'PUT', {name});
        } else {
          roleId = (await coreApi('/admin/roles', 'POST', {name,code})).id;
        }
        await coreApi('/admin/roles/' + encodeURIComponent(roleId) + '/permissions', 'PUT', {codes});
        toast(id ? 'Роль обновлена' : 'Роль создана');
        closeRole();
        peopleLoaded = false;
        await ensureRoleData(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить роль';
      } finally { save.disabled = false; }
    });

    /* ── Excel-like grid kit (shared by Снабжение, Номенклатура, Поставщики) ──
       Every grid gets the four spreadsheet behaviours: per-column value filters,
       drag-to-resize columns, auto-fit width to content, and click-to-sort. */
    const MIN_COL_WIDTH = 56;
    const MAX_COL_WIDTH = 560;
    const gridColumnsById = new Map();
    // widths measured by auto-fit, kept per session so re-renders don't reshuffle columns
    const gridAutoWidths = new Map();
    function autoWidthsOf(gridId) {
      if (!gridAutoWidths.has(gridId)) gridAutoWidths.set(gridId, new Map());
      return gridAutoWidths.get(gridId);
    }
    function gridWidths(gridId) {
      try {
        const saved = JSON.parse(localStorage.getItem('snab.colw.' + gridId) || '{}');
        return saved && typeof saved === 'object' ? saved : {};
      } catch { return {}; }
    }
    function saveGridWidth(gridId, key, width) {
      if (!key) return;
      const store = gridWidths(gridId);
      store[key] = width;
      localStorage.setItem('snab.colw.' + gridId, JSON.stringify(store));
    }
    function clearGridWidths(gridId) {
      localStorage.removeItem('snab.colw.' + gridId);
      autoWidthsOf(gridId).clear();
    }
    /* A grid's <colgroup>: user-set widths win, everything else is auto-fitted after render. */
    function colgroupHtml(gridId, columns) {
      const store = gridWidths(gridId);
      const fitted = autoWidthsOf(gridId);
      return '<colgroup>' + columns.map((column) => {
        const saved = store[column.key];
        const noFit = column.fit === false ? ' data-no-fit="1"' : '';
        if (saved) return '<col data-col-key="' + esc(column.key) + '"' + noFit + ' data-user-width="1" style="width:' + esc(saved) + '">';
        const auto = fitted.get(column.key);
        if (auto) return '<col data-col-key="' + esc(column.key) + '"' + noFit + ' data-auto-width="1" style="width:' + esc(auto) + '">';
        return '<col data-col-key="' + esc(column.key) + '"' + noFit + (column.width ? ' style="width:' + column.width + 'px"' : '') + '>';
      }).join('') + '</colgroup>';
    }
    function resizeHandleHtml(index) {
      return '<span class="col-resize-handle" data-resize-index="' + index + '" title="Потяните, чтобы изменить ширину. Двойной клик — по содержимому"></span>';
    }
    function gridHeaderCells(table) {
      const headRows = table.querySelectorAll('thead tr');
      const last = headRows[headRows.length - 1];
      return last ? [...last.children] : [];
    }
    /* Auto-fit = let the browser lay the table out by content, then freeze those widths. */
    function gridOnScreen(table) { return !!(table && table.offsetParent !== null); }
    function autofitColumns(table, indices, persist) {
      if (!table || !indices.length || !gridOnScreen(table)) return;
      const cols = [...table.querySelectorAll('col')];
      if (!cols.length) return;
      const previousWidths = cols.map((col) => col.style.width);
      const previousLayout = table.style.tableLayout;
      const previousMinWidth = table.style.minWidth;
      const previousWidth = table.style.width;
      table.classList.add('measuring');
      table.style.tableLayout = 'auto';
      table.style.minWidth = '0';
      table.style.width = 'max-content';
      for (const index of indices) if (cols[index]) cols[index].style.width = 'auto';
      const headCells = gridHeaderCells(table);
      const measured = indices.map((index) => (headCells[index] ? headCells[index].getBoundingClientRect().width : 0));
      cols.forEach((col, index) => { col.style.width = previousWidths[index]; });
      table.style.tableLayout = previousLayout;
      table.style.minWidth = previousMinWidth;
      table.style.width = previousWidth;
      table.classList.remove('measuring');
      const columns = gridColumnsById.get(table.id) || [];
      const fitted = autoWidthsOf(table.id);
      indices.forEach((index, position) => {
        if (!cols[index] || !measured[position]) return;
        const width = Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, measured[position] + 10)));
        const key = columns[index] ? columns[index].key : cols[index].dataset.colKey;
        cols[index].style.width = width + 'px';
        fitted.set(key, width + 'px');
        if (persist) {
          cols[index].dataset.userWidth = '1';
          saveGridWidth(table.id, key, width + 'px');
        }
      });
    }
    function autofitAll(table, persist) {
      if (!table) return;
      const indices = [...table.querySelectorAll('col')]
        .map((col, index) => (col.dataset.noFit ? -1 : index))
        .filter((index) => index >= 0);
      autofitColumns(table, indices, persist);
    }
    /* Columns the user never touched follow their content, like a freshly opened sheet. */
    function autofitUntouched(table) {
      if (!table) return;
      const cols = [...table.querySelectorAll('col')];
      const indices = cols
        .map((col, index) => (col.dataset.userWidth || col.dataset.autoWidth || col.dataset.noFit ? -1 : index))
        .filter((index) => index >= 0);
      autofitColumns(table, indices, false);
    }
    /* the procurement register keeps its own min-width/scrollbar in sync with the columns */
    function gridWidthsChanged(table) { syncGridWidth(table); }
    let columnResize = null;
    document.addEventListener('pointerdown', (event) => {
      const handle = event.target instanceof Element ? event.target.closest('.col-resize-handle') : null;
      if (!handle) return;
      const table = handle.closest('table');
      const index = Number(handle.dataset.resizeIndex);
      const col = table ? table.querySelectorAll('col')[index] : null;
      if (!col) return;
      event.preventDefault();
      const headCell = gridHeaderCells(table)[index];
      columnResize = {
        table,
        col,
        handle,
        startX: event.clientX,
        startWidth: headCell ? headCell.getBoundingClientRect().width : parseFloat(col.style.width) || 140,
      };
      handle.classList.add('resizing');
      document.body.classList.add('col-resizing');
      try { handle.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    });
    document.addEventListener('pointermove', (event) => {
      if (!columnResize) return;
      const width = Math.max(MIN_COL_WIDTH, Math.round(columnResize.startWidth + event.clientX - columnResize.startX));
      columnResize.col.style.width = width + 'px';
    });
    function endColumnResize() {
      if (!columnResize) return;
      const { table, col, handle } = columnResize;
      col.dataset.userWidth = '1';
      autoWidthsOf(table.id).set(col.dataset.colKey, col.style.width);
      saveGridWidth(table.id, col.dataset.colKey, col.style.width);
      handle.classList.remove('resizing');
      document.body.classList.remove('col-resizing');
      columnResize = null;
      gridWidthsChanged(table);
    }
    document.addEventListener('pointerup', endColumnResize);
    document.addEventListener('pointercancel', endColumnResize);
    document.addEventListener('dblclick', (event) => {
      const handle = event.target.closest('.col-resize-handle');
      if (!handle) return;
      const table = handle.closest('table');
      autofitColumns(table, [Number(handle.dataset.resizeIndex)], true);
      gridWidthsChanged(table);
    });
    /* ── declarative Excel-like grid for the catalog views (Номенклатура, Поставщики) ──
       Owns colgroup + header rendering so sorting, filtering, resizing and auto-fit
       behave exactly like the procurement register. The <tbody> element is reused so
       existing row-level click handlers stay attached. */
    const dataGrids = new Map();
    function createDataGrid(config) {
      const state = {
        sortKey: config.defaultSortKey || '',
        sortDir: config.defaultSortDir || 'asc',
        filters: {},
        page: 1,
        pageSize: 25,
        hidden: new Set(),
      };
      const columnByKey = new Map(config.columns.map((column) => [column.key, column]));
      const tableId = config.tableId;
      const storeKey = 'snab.gridprefs.' + tableId;
      try {
        const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
        if (saved && typeof saved === 'object') {
          if (Array.isArray(saved.hidden)) state.hidden = new Set(saved.hidden.filter((key) => columnByKey.has(key)));
          if (saved.pageSize) state.pageSize = Number(saved.pageSize) || 25;
          if (saved.sortKey && columnByKey.has(saved.sortKey)) {
            state.sortKey = saved.sortKey;
            state.sortDir = saved.sortDir === 'desc' ? 'desc' : 'asc';
          }
        }
      } catch { /* ignore malformed preferences */ }
      if (!localStorage.getItem(storeKey) && config.defaultVisible) {
        state.hidden = new Set(config.columns.map((column) => column.key).filter((key) => !config.defaultVisible.includes(key)));
      }
      function savePrefs() {
        localStorage.setItem(storeKey, JSON.stringify({
          hidden: [...state.hidden], pageSize: state.pageSize, sortKey: state.sortKey, sortDir: state.sortDir,
        }));
      }
      function shownColumns() {
        const out = config.columns.filter((column) => !state.hidden.has(column.key));
        return out.length ? out : [config.columns[0]];
      }
      function layoutColumns() {
        return shownColumns().concat([{ key:'__actions', label:'Действия', width: config.actionsWidth || 96, fit:false }]);
      }
      function cellValue(row, key) {
        const column = columnByKey.get(key);
        return column && column.value ? column.value(row) : row[key];
      }
      function labelOf(key) {
        const column = columnByKey.get(key);
        if (!column) return key;
        return column.i18n ? t(column.i18n) : (column.label || key);
      }
      function cellText(row, column) {
        if (column.text) return column.text(row);
        const raw = cellValue(row, column.key);
        return raw === null || raw === undefined || raw === '' ? '—' : String(raw);
      }
      const host = document.getElementById(config.hostId);
      function el(selector) { return host.querySelector(selector); }
      function searchInputs() {
        return (config.searchInputIds || []).map((id) => document.getElementById(id)).filter(Boolean);
      }
      function searchQuery() {
        const external = searchInputs().map((input) => input.value.trim()).find((value) => value);
        if (external !== undefined && config.searchInputIds) return normalizedCell(external || '');
        const input = el('[data-grid-search]');
        return input ? normalizedCell(input.value) : '';
      }
      function matchesQuery(row, query) {
        if (config.searchRow) return config.searchRow(row, query);
        return config.columns.some((column) => normalizedCell(cellValue(row, column.key)).includes(query));
      }
      function filteredRows() {
        const query = searchQuery();
        const filters = Object.entries(state.filters);
        return config.source().filter((row) => {
          if (config.rowFilter && !config.rowFilter(row)) return false;
          if (query && !matchesQuery(row, query)) return false;
          for (const [key, filter] of filters) if (!matchesColumnFilter(cellValue(row, key), filter)) return false;
          return true;
        });
      }
      function sortValue(row, key) {
        const column = columnByKey.get(key);
        const raw = cellValue(row, key);
        if (column && column.numeric) return Number(raw) || 0;
        const asDate = parseDateLike(raw);
        if (asDate !== null) return asDate;
        return String(raw ?? '').toLowerCase();
      }
      function sortRows(data) {
        if (!state.sortKey) return data;
        const dir = state.sortDir === 'desc' ? -1 : 1;
        return [...data].sort((a, b) => {
          const av = sortValue(a, state.sortKey);
          const bv = sortValue(b, state.sortKey);
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
          return String(av).localeCompare(String(bv), 'ru', { numeric:true, sensitivity:'base' }) * dir;
        });
      }
      /* the shell is the procurement register's: toolbar → filter chips → table → pager */
      function shellHtml() {
        return '' +
          '<div class="toolbar">' +
            (config.searchInputIds ? '' : '<input class="search" data-grid-search placeholder="' + esc(config.searchPlaceholder || 'Поиск по таблице…') + '" />') +
            '<div class="settings-wrap">' +
              '<button class="btn ghost" type="button" data-grid-toggle-columns><i class="ti ti-columns-3" aria-hidden="true"></i> Столбцы <span class="filter-count" data-grid-column-count>0</span></button>' +
              '<div class="settings-panel hidden" data-grid-columns-panel>' +
                '<div class="settings-head"><div><strong>Настройки таблицы</strong><span>Показывайте только нужные поля.</span></div>' +
                '<div class="settings-actions">' +
                (config.defaultVisible ? '<button class="mini-action" type="button" data-grid-columns-default>По умолчанию</button>' : '') +
                '<button class="mini-action" type="button" data-grid-columns-all>Все</button></div></div>' +
                '<div class="columns-grid" data-grid-columns-list></div>' +
              '</div>' +
            '</div>' +
            (config.simple ? '' :
              '<button class="btn ghost" type="button" data-grid-clear="' + tableId + '">Очистить</button>') +
          '</div>' +
          (config.simple ? '' :
          '<section class="filters-panel" data-grid-filters-panel aria-label="Фильтры таблицы">' +
            '<div class="filter-summary-head"><div><strong>Активные фильтры</strong><span>Откройте фильтр из заголовка нужного столбца.</span></div><button class="mini" type="button" data-grid-clear="' + tableId + '">Очистить все</button></div>' +
            '<div class="active-filter-list" data-grid-chips></div>' +
          '</section>') +
          '<section class="table-shell">' +
            '<div class="scroll" data-grid-scroll><table class="grid" id="' + tableId + '"></table></div>' +
            '<div class="table-pager">' +
              '<div class="pager-info" data-grid-pager-info>Строк нет</div>' +
              '<div class="pager-actions">' +
                '<span class="pager-info">Показывать</span>' +
                '<select data-grid-page-size><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option></select>' +
                '<button class="pager-btn" type="button" data-grid-page="first" aria-label="Первая страница">«</button>' +
                '<button class="pager-btn" type="button" data-grid-page="prev" aria-label="Предыдущая страница">‹</button>' +
                '<span class="pager-info" data-grid-page-info>1 / 1</span>' +
                '<button class="pager-btn" type="button" data-grid-page="next" aria-label="Следующая страница">›</button>' +
                '<button class="pager-btn" type="button" data-grid-page="last" aria-label="Последняя страница">»</button>' +
              '</div>' +
            '</div>' +
          '</section>';
      }
      function headHtml(columns) {
        return '<tr>' + columns.map((column, index) => {
          const active = state.sortKey === column.key;
          const mark = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '↕';
          const filtered = !!state.filters[column.key];
          const label = labelOf(column.key);
          return '<th class="' + (index === 0 ? 'sticky-col ' : '') + (filtered ? 'filter-active' : '') + '">' +
            '<div class="header-cell-control">' +
            '<button class="sort-head ' + (active ? 'active' : '') + '" type="button" data-grid-sort="' + esc(column.key) + '" title="Сортировать по столбцу">' +
            '<span' + (column.i18n ? ' data-i18n="' + esc(column.i18n) + '"' : '') + '>' + esc(label) + '</span>' +
            '<span class="sort-mark">' + mark + '</span></button>' +
            (config.simple ? '' : '<button class="column-filter-button ' + (filtered ? 'active' : '') + '" type="button" data-grid-filter="' + esc(column.key) + '" title="Фильтр столбца" aria-label="Фильтр: ' + esc(label) + '"><i class="ti ti-filter"></i></button>') +
            '</div>' + resizeHandleHtml(index) + '</th>';
        }).join('') + '<th class="sticky-actions">Действия</th></tr>';
      }
      /* optional banner row that spans related columns, e.g. ДАТА / АДРЕСАТ / ТОВАР */
      function groupRowHtml(columns) {
        if (!config.groups) return '';
        const shown = new Set(columns.map((column) => column.key));
        let offset = 0;
        const spans = [];
        for (const [label, count] of config.groups) {
          const slice = config.columns.slice(offset, offset + count);
          const visible = slice.filter((column) => shown.has(column.key)).length;
          if (visible) spans.push([label, visible]);
          offset += count;
        }
        return '<tr>' + spans.map(([label, span]) => '<th class="group" colspan="' + span + '">' + esc(label) + '</th>').join('') + '<th class="group"></th></tr>';
      }
      function rowHtml(row, columns) {
        const cells = columns.map((column, index) => {
          const shown = cellText(row, column);
          const title = config.cellTitle ? config.cellTitle(row, column, shown) : shown;
          return '<td class="' + (column.numeric ? 'num' : '') + (index === 0 ? ' sticky-col' : '') + '" title="' + esc(title) + '">' + esc(shown) + '</td>';
        }).join('');
        const attrs = config.rowAttrs ? ' ' + config.rowAttrs(row) : '';
        return '<tr' + attrs + '>' + cells + '<td class="sticky-actions"><div class="actions">' + config.actions(row) + '</div></td></tr>';
      }
      function renderChips() {
        if (config.simple) return;
        const active = Object.entries(state.filters);
        el('[data-grid-chips]').innerHTML = active.length ? active.map(([key, filter]) => {
          const selected = new Set(filter.values || []);
          const labels = filterOptionsFor(grid, key).filter((option) => selected.has(option.value)).map((option) => option.label);
          const summary = labels.length <= 2 ? labels.join(', ') : labels.slice(0,2).join(', ') + ' +' + (labels.length - 2);
          return '<div class="active-filter-chip"><strong>' + esc(labelOf(key)) + '</strong><span>' + esc(summary || 'Нет значений') + '</span><button type="button" data-grid-remove-filter="' + esc(key) + '" aria-label="Убрать фильтр"><i class="ti ti-x"></i></button></div>';
        }).join('') : '<span class="filter-empty">Фильтры не применены.</span>';
        const badge = el('[data-grid-filter-count]');
        if (badge) {
          badge.textContent = active.length;
          badge.style.display = active.length ? 'inline-block' : 'none';
        }
      }
      function renderColumnSettings() {
        el('[data-grid-columns-list]').innerHTML = config.columns.map((column) =>
          '<label class="column-option"><input type="checkbox" data-grid-column-key="' + esc(column.key) + '"' + (state.hidden.has(column.key) ? '' : ' checked') + '><span>' + esc(labelOf(column.key)) + '</span></label>'
        ).join('');
        const badge = el('[data-grid-column-count]');
        badge.textContent = state.hidden.size;
        badge.style.display = state.hidden.size ? 'inline-block' : 'none';
      }
      function updatePager(total) {
        const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
        if (state.page > pageCount) state.page = pageCount;
        const start = total ? (state.page - 1) * state.pageSize + 1 : 0;
        const end = Math.min(total, state.page * state.pageSize);
        el('[data-grid-pager-info]').textContent = total ? 'Показаны ' + fmt.format(start) + '–' + fmt.format(end) + ' из ' + fmt.format(total) : 'Строк нет';
        el('[data-grid-page-info]').textContent = state.page + ' / ' + pageCount;
        el('[data-grid-page="first"]').disabled = state.page <= 1;
        el('[data-grid-page="prev"]').disabled = state.page <= 1;
        el('[data-grid-page="next"]').disabled = state.page >= pageCount;
        el('[data-grid-page="last"]').disabled = state.page >= pageCount;
        el('[data-grid-page-size]').value = String(state.pageSize);
        return pageCount;
      }
      function render() {
        if (!host.dataset.ready) { host.innerHTML = shellHtml(); host.dataset.ready = '1'; wireShell(); }
        const columns = layoutColumns();
        gridColumnsById.set(tableId, columns);
        const dataColumns = shownColumns();
        const matched = filteredRows();
        if (config.onRender) config.onRender(matched);
        const data = sortRows(matched);
        updatePager(data.length);
        const pageRows = data.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
        const table = document.getElementById(tableId);
        table.innerHTML =
          colgroupHtml(tableId, columns) +
          '<thead>' + groupRowHtml(dataColumns) + headHtml(dataColumns) + '</thead><tbody>' +
          (pageRows.length
            ? pageRows.map((row) => rowHtml(row, dataColumns)).join('')
            : '<tr><td colspan="' + (dataColumns.length + 1) + '"><div class="table-empty">' + esc(config.emptyText || t('common.empty')) + '</div></td></tr>') +
          '</tbody>';
        renderChips();
        renderColumnSettings();
        autofitUntouched(table);
        syncGridWidth(table);
      }
      function showError(message) {
        if (!host.dataset.ready) { host.innerHTML = shellHtml(); host.dataset.ready = '1'; wireShell(); }
        const columns = shownColumns();
        document.getElementById(tableId).innerHTML =
          colgroupHtml(tableId, layoutColumns()) + '<thead>' + headHtml(columns) + '</thead>' +
          '<tbody><tr><td colspan="' + (columns.length + 1) + '"><div class="table-empty">' + esc(message) + '</div></td></tr></tbody>';
      }
      const grid = {
        id: tableId,
        filters: state.filters,
        labelOf,
        valuesFor: (key) => config.source().map((row) => cellValue(row, key)),
        onChange: () => { state.page = 1; render(); },
        sortBy: (key, dir) => { state.sortKey = key; state.sortDir = dir; savePrefs(); state.page = 1; render(); },
        clear: () => {
          for (const key of Object.keys(state.filters)) delete state.filters[key];
          const input = el('[data-grid-search]');
          if (input) input.value = '';
          for (const external of searchInputs()) external.value = '';
          state.page = 1;
          render();
        },
        state,
        render,
        showError,
      };
      function wireShell() {
        const table = document.getElementById(tableId);
        table.addEventListener('click', (event) => {
          const filterButton = event.target.closest('[data-grid-filter]');
          if (filterButton) {
            event.stopPropagation();
            openColumnFilter(grid, filterButton.dataset.gridFilter, filterButton);
            return;
          }
          const sortButton = event.target.closest('[data-grid-sort]');
          if (!sortButton) return;
          const key = sortButton.dataset.gridSort;
          if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
          else { state.sortKey = key; state.sortDir = (columnByKey.get(key) || {}).numeric ? 'desc' : 'asc'; }
          savePrefs();
          state.page = 1;
          render();
        });
        let searchTimer = null;
        const onSearchInput = () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => { state.page = 1; render(); }, 120);
        };
        const ownSearch = el('[data-grid-search]');
        if (ownSearch) ownSearch.addEventListener('input', onSearchInput);
        // Some grids can share external search boxes; keep them mirrored when present.
        for (const external of searchInputs()) {
          external.addEventListener('input', () => {
            for (const other of searchInputs()) if (other !== external) other.value = external.value;
            onSearchInput();
          });
        }
        el('[data-grid-toggle-columns]').addEventListener('click', (event) => {
          event.stopPropagation();
          if (!config.simple) el('[data-grid-filters-panel]').classList.remove('open');
          el('[data-grid-columns-panel]').classList.toggle('hidden');
        });
        el('[data-grid-columns-panel]').addEventListener('click', (event) => event.stopPropagation());
        el('[data-grid-columns-all]').addEventListener('click', () => { state.hidden.clear(); savePrefs(); render(); });
        const defaultColumnsButton = el('[data-grid-columns-default]');
        if (defaultColumnsButton) defaultColumnsButton.addEventListener('click', () => {
          state.hidden = new Set(config.columns.map((column) => column.key).filter((key) => !config.defaultVisible.includes(key)));
          savePrefs();
          render();
        });
        el('[data-grid-columns-list]').addEventListener('change', (event) => {
          const input = event.target.closest('[data-grid-column-key]');
          if (!input) return;
          const key = input.dataset.gridColumnKey;
          if (input.checked) state.hidden.delete(key);
          else if (state.hidden.size + 1 >= config.columns.length) { input.checked = true; toast('Нужен хотя бы один столбец'); return; }
          else state.hidden.add(key);
          savePrefs();
          render();
        });
        if (!config.simple) el('[data-grid-chips]').addEventListener('click', (event) => {
          const button = event.target.closest('[data-grid-remove-filter]');
          if (!button) return;
          delete state.filters[button.dataset.gridRemoveFilter];
          state.page = 1;
          render();
        });
        el('[data-grid-page-size]').addEventListener('change', (event) => {
          state.pageSize = Number(event.target.value) || 25;
          state.page = 1;
          savePrefs();
          render();
        });
        host.addEventListener('click', (event) => {
          const button = event.target.closest('[data-grid-page]');
          if (!button) return;
          const total = filteredRows().length;
          const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
          const move = button.dataset.gridPage;
          if (move === 'first') state.page = 1;
          if (move === 'prev') state.page = Math.max(1, state.page - 1);
          if (move === 'next') state.page = Math.min(pageCount, state.page + 1);
          if (move === 'last') state.page = pageCount;
          render();
        });
      }
      dataGrids.set(tableId, grid);
      return grid;
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-grid-clear]');
      if (!button) return;
      const grid = dataGrids.get(button.dataset.gridClear);
      if (grid) grid.clear();
    });

    /* ── unit types (shared by the settings view AND the namenklatura unit select) ── */
    let unitTypesItems = [];
    let unitTypesLoaded = false;
    async function loadUnitTypes(force = false) {
      if (unitTypesLoaded && !force) return unitTypesItems;
      unitTypesItems = await coreApi('/admin/unit-types');
      unitTypesLoaded = true;
      return unitTypesItems;
    }
    function unitLabel(u) {
      const lang = currentLang();
      if (lang === 'uz' && u.nameUz) return u.nameUz;
      if (lang === 'tr' && u.nameTr) return u.nameTr;
      return u.nameRu;
    }
    async function ensureUnitTypes(force = false) {
      if (!unitTypeDragWired) { unitTypeDragWired = true; wireUnitTypeDragReorder(); }
      try {
        await loadUnitTypes(force);
        renderUnitTypes();
      } catch (err) {
        document.getElementById('unitTypesList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить единицы измерения') + '</div>';
      }
    }
    function renderUnitTypes() {
      const head = '<div class="unit-type-row head"><span></span><span>' + t('unitTypes.colCode') + '</span><span>' + t('unitTypes.colNameRu') + '</span><span>' + t('unitTypes.colNameUz') + '</span><span>' + t('unitTypes.colNameTr') + '</span><span></span></div>';
      const body = unitTypesItems.map((u) => '<div class="unit-type-row" draggable="true" data-unit-row="' + esc(u.id) + '">' +
        '<span class="drag-handle" title="Перетащите для изменения порядка"><i class="ti ti-grip-vertical" aria-hidden="true"></i></span>' +
        '<code>' + esc(u.code) + '</code><span>' + esc(u.nameRu) + '</span><span>' + esc(u.nameUz || '—') + '</span><span>' + esc(u.nameTr || '—') + '</span><div class="unit-type-actions">' +
        '<button class="icon-action" type="button" title="Изменить" data-edit-unit="' + esc(u.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
        '<button class="icon-action danger" type="button" title="Удалить" data-delete-unit="' + esc(u.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>' +
        '</div></div>').join('');
      document.getElementById('unitTypesList').innerHTML = head + (body || '<div class="empty-admin">' + t('common.empty') + '</div>');
    }
    async function persistUnitTypeOrder() {
      try {
        await coreApi('/admin/unit-types/reorder', 'PUT', { order: unitTypesItems.map((u, i) => ({ id: u.id, order_index: i })) });
      } catch (err) { toast(err instanceof Error ? err.message : 'Не удалось сохранить порядок'); await ensureUnitTypes(true); }
    }
    function wireUnitTypeDragReorder() {
      const list = document.getElementById('unitTypesList');
      let draggedId = null;
      list.addEventListener('dragstart', (event) => {
        const row = event.target.closest('[data-unit-row]');
        if (!row) return;
        draggedId = row.dataset.unitRow;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
      });
      list.addEventListener('dragend', (event) => {
        const row = event.target.closest('[data-unit-row]');
        if (row) row.classList.remove('dragging');
      });
      list.addEventListener('dragover', (event) => {
        event.preventDefault();
        const overRow = event.target.closest('[data-unit-row]');
        if (!overRow || !draggedId || overRow.dataset.unitRow === draggedId) return;
        const fromIdx = unitTypesItems.findIndex((u) => u.id === draggedId);
        const toIdx = unitTypesItems.findIndex((u) => u.id === overRow.dataset.unitRow);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = unitTypesItems.splice(fromIdx, 1);
        unitTypesItems.splice(toIdx, 0, moved);
        renderUnitTypes();
      });
      list.addEventListener('drop', (event) => {
        event.preventDefault();
        if (draggedId) persistUnitTypeOrder();
        draggedId = null;
      });
    }
    let unitTypeDragWired = false;
    function openUnitType(u) {
      document.getElementById('unitTypeId').value = u ? u.id : '';
      document.getElementById('unitTypeTitle').textContent = u ? 'Изменить единицу' : 'Новая единица';
      document.getElementById('unitTypeCode').value = u ? u.code : '';
      document.getElementById('unitTypeNameRu').value = u ? u.nameRu : '';
      document.getElementById('unitTypeNameUz').value = u ? u.nameUz || '' : '';
      document.getElementById('unitTypeNameTr').value = u ? u.nameTr || '' : '';
      document.getElementById('unitTypeErr').textContent = '';
      document.getElementById('unitTypeModal').classList.remove('hidden');
      document.getElementById('unitTypeCode').focus();
    }
    function closeUnitType() { document.getElementById('unitTypeModal').classList.add('hidden'); }
    document.getElementById('addUnitType').addEventListener('click', () => openUnitType(null));
    wireExcelImport('importUnitType', 'importUnitTypeFile', '/admin/unit-types/import', () => ensureUnitTypes(true));
    document.getElementById('unitTypeCancel').addEventListener('click', closeUnitType);
    document.getElementById('unitTypesList').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-unit]');
      if (editBtn) { openUnitType(unitTypesItems.find((u) => u.id === editBtn.dataset.editUnit)); return; }
      const delBtn = event.target.closest('[data-delete-unit]');
      if (delBtn) {
        if (!confirm('Удалить эту единицу измерения?')) return;
        try { await coreApi('/admin/unit-types/' + encodeURIComponent(delBtn.dataset.deleteUnit), 'DELETE'); toast('Удалено'); await ensureUnitTypes(true); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
      }
    });
    document.getElementById('unitTypeForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('unitTypeId').value;
      const payload = {
        code: document.getElementById('unitTypeCode').value.trim(),
        nameRu: document.getElementById('unitTypeNameRu').value.trim(),
        nameUz: document.getElementById('unitTypeNameUz').value.trim(),
        nameTr: document.getElementById('unitTypeNameTr').value.trim(),
      };
      const save = document.getElementById('unitTypeSave');
      const error = document.getElementById('unitTypeErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/admin/unit-types/' + encodeURIComponent(id), 'PUT', payload);
        else await coreApi('/admin/unit-types', 'POST', payload);
        toast(id ? 'Единица обновлена' : 'Единица добавлена');
        closeUnitType();
        await ensureUnitTypes(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── shared: factories (branches) lookup, used by otdels + warehouses ── */
    let factoriesItems = [];
    let factoriesLoaded = false;
    async function loadFactories(force = false) {
      if (factoriesLoaded && !force) return factoriesItems;
      factoriesItems = await coreApi('/admin/factories');
      factoriesLoaded = true;
      return factoriesItems;
    }

    /* ── otdels (departments), with branch multi-assignment ── */
    let otdelsItems = [];
    let otdelsLoaded = false;
    async function ensureOtdels(force = false) {
      try {
        const [depts] = await Promise.all([coreApi('/admin/departments'), loadFactories()]);
        otdelsItems = depts;
        otdelsLoaded = true;
        renderOtdels();
      } catch (err) {
        document.getElementById('otdelsList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить отделы') + '</div>';
      }
    }
    function renderOtdels() {
      const factoryById = new Map(factoriesItems.map((f) => [f.id, f.name]));
      const head = '<div class="unit-type-row head" style="grid-template-columns:1fr 1fr 1fr 1.4fr 76px;"><span>' + t('unitTypes.colNameRu') + '</span><span>' + t('unitTypes.colNameUz') + '</span><span>' + t('unitTypes.colNameTr') + '</span><span data-i18n="otdels.branches">Филиалы</span><span></span></div>';
      const body = otdelsItems.map((d) => {
        const chips = (d.factoryIds || []).map((id) => '<span class="pill">' + esc(factoryById.get(id) || '—') + '</span>').join('') || '<span class="identity-meta">—</span>';
        return '<div class="unit-type-row" style="grid-template-columns:1fr 1fr 1fr 1.4fr 76px;"><span>' + esc(d.name) + '</span><span>' + esc(d.nameUz || '—') + '</span><span>' + esc(d.nameTr || '—') + '</span><div class="chip-list">' + chips + '</div><div class="unit-type-actions">' +
          '<button class="icon-action" type="button" title="Изменить" data-edit-otdel="' + esc(d.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
          '<button class="icon-action danger" type="button" title="Удалить" data-delete-otdel="' + esc(d.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>' +
          '</div></div>';
      }).join('');
      document.getElementById('otdelsList').innerHTML = head + (body || '<div class="empty-admin">' + t('common.empty') + '</div>');
    }
    function openOtdel(d) {
      document.getElementById('otdelId').value = d ? d.id : '';
      document.getElementById('otdelTitle').textContent = d ? 'Изменить отдел' : 'Новый отдел';
      document.getElementById('otdelNameRu').value = d ? d.name : '';
      document.getElementById('otdelNameUz').value = d ? d.nameUz || '' : '';
      document.getElementById('otdelNameTr').value = d ? d.nameTr || '' : '';
      const selected = new Set(d ? d.factoryIds || [] : []);
      document.getElementById('otdelFactories').innerHTML = factoriesItems.map((f) =>
        '<label><input type="checkbox" value="' + esc(f.id) + '" ' + (selected.has(f.id) ? 'checked' : '') + ' /><span>' + esc(f.name) + '</span></label>',
      ).join('') || '<span class="identity-meta">Нет филиалов</span>';
      document.getElementById('otdelErr').textContent = '';
      document.getElementById('otdelModal').classList.remove('hidden');
      document.getElementById('otdelNameRu').focus();
    }
    function closeOtdel() { document.getElementById('otdelModal').classList.add('hidden'); }
    document.getElementById('addOtdel').addEventListener('click', () => openOtdel(null));
    document.getElementById('otdelCancel').addEventListener('click', closeOtdel);
    document.getElementById('otdelsList').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-otdel]');
      if (editBtn) { openOtdel(otdelsItems.find((d) => d.id === editBtn.dataset.editOtdel)); return; }
      const delBtn = event.target.closest('[data-delete-otdel]');
      if (delBtn) {
        if (!confirm('Удалить этот отдел?')) return;
        try { await coreApi('/admin/departments/' + encodeURIComponent(delBtn.dataset.deleteOtdel), 'DELETE'); toast('Удалено'); await ensureOtdels(true); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
      }
    });
    document.getElementById('otdelForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('otdelId').value;
      const factoryIds = [...document.querySelectorAll('#otdelFactories input:checked')].map((el) => el.value);
      const payload = {
        name: document.getElementById('otdelNameRu').value.trim(),
        nameUz: document.getElementById('otdelNameUz').value.trim(),
        nameTr: document.getElementById('otdelNameTr').value.trim(),
        factoryIds,
      };
      const save = document.getElementById('otdelSave');
      const error = document.getElementById('otdelErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/admin/departments/' + encodeURIComponent(id), 'PUT', payload);
        else await coreApi('/admin/departments', 'POST', payload);
        toast(id ? 'Отдел обновлён' : 'Отдел добавлен');
        closeOtdel();
        await ensureOtdels(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── warehouses (sklad) ── */
    let warehousesItems = [];
    async function ensureWarehouses() {
      try {
        const [items, users] = await Promise.all([coreApi('/admin/warehouses'), coreApi('/admin/users'), loadFactories()]);
        warehousesItems = items;
        people = users || [];
        renderWarehouses();
      } catch (err) {
        document.getElementById('warehousesList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить склады') + '</div>';
      }
    }
    function renderWarehouses() {
      const factoryById = new Map(factoriesItems.map((f) => [f.id, f.name]));
      const head = '<div class="unit-type-row head" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr 76px;"><span>' + t('unitTypes.colNameRu') + '</span><span>' + t('unitTypes.colNameUz') + '</span><span>' + t('unitTypes.colNameTr') + '</span><span>' + t('warehouses.colBranch') + '</span><span>' + t('warehouses.responsible') + '</span><span></span></div>';
      const body = warehousesItems.map((w) => '<div class="unit-type-row" style="grid-template-columns:1fr 1fr 1fr 1fr 1fr 76px;"><span>' + esc(w.name) + '</span><span>' + esc(w.nameUz || '—') + '</span><span>' + esc(w.nameTr || '—') + '</span><span>' + esc(factoryById.get(w.factoryId) || '—') + '</span><span>' + esc(w.responsibleUserName || '—') + '</span><div class="unit-type-actions">' +
        '<button class="icon-action" type="button" title="Изменить" data-edit-warehouse="' + esc(w.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
        '<button class="icon-action danger" type="button" title="Удалить" data-delete-warehouse="' + esc(w.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>' +
        '</div></div>').join('');
      document.getElementById('warehousesList').innerHTML = head + (body || '<div class="empty-admin">' + t('common.empty') + '</div>');
    }
    function openWarehouse(w) {
      document.getElementById('warehouseId').value = w ? w.id : '';
      document.getElementById('warehouseTitle').textContent = w ? 'Изменить склад' : 'Новый склад';
      document.getElementById('warehouseName').value = w ? w.name : '';
      document.getElementById('warehouseNameUz').value = w ? w.nameUz || '' : '';
      document.getElementById('warehouseNameTr').value = w ? w.nameTr || '' : '';
      fillSelect('warehouseFactory', factoriesItems, 'id', 'name', true);
      document.getElementById('warehouseFactory').value = w ? w.factoryId || '' : '';
      const responsible = document.getElementById('warehouseResponsible');
      responsible.innerHTML = '<option value="">Не назначен</option>' + people.filter((u) => u.status === 'active').map((u) => '<option value="' + esc(u.id) + '">' + esc(u.fullName) + '</option>').join('');
      responsible.value = w ? w.responsibleUserId || '' : '';
      document.getElementById('warehouseErr').textContent = '';
      document.getElementById('warehouseModal').classList.remove('hidden');
      document.getElementById('warehouseName').focus();
    }
    function closeWarehouse() { document.getElementById('warehouseModal').classList.add('hidden'); }
    document.getElementById('addWarehouse').addEventListener('click', () => openWarehouse(null));
    document.getElementById('warehouseCancel').addEventListener('click', closeWarehouse);
    document.getElementById('warehousesList').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-warehouse]');
      if (editBtn) { openWarehouse(warehousesItems.find((w) => w.id === editBtn.dataset.editWarehouse)); return; }
      const delBtn = event.target.closest('[data-delete-warehouse]');
      if (delBtn) {
        if (!confirm('Удалить этот склад?')) return;
        try { await coreApi('/admin/warehouses/' + encodeURIComponent(delBtn.dataset.deleteWarehouse), 'DELETE'); toast('Удалено'); await ensureWarehouses(); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
      }
    });
    document.getElementById('warehouseForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('warehouseId').value;
      const payload = {
        name: document.getElementById('warehouseName').value.trim(),
        nameUz: document.getElementById('warehouseNameUz').value.trim(),
        nameTr: document.getElementById('warehouseNameTr').value.trim(),
        factory_id: document.getElementById('warehouseFactory').value || '',
        responsibleUserId: document.getElementById('warehouseResponsible').value || null,
      };
      const save = document.getElementById('warehouseSave');
      const error = document.getElementById('warehouseErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/admin/warehouses/' + encodeURIComponent(id), 'PUT', payload);
        else await coreApi('/admin/warehouses', 'POST', payload);
        toast(id ? 'Склад обновлён' : 'Склад добавлен');
        closeWarehouse();
        await ensureWarehouses();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── branches (filialy) — same factories table loadFactories()/factoriesItems
       already fetch for otdels+warehouses; this view manages those records. ── */
    async function ensureBranches() {
      try {
        await loadFactories(true);
        renderBranches();
      } catch (err) {
        document.getElementById('branchesList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить филиалы') + '</div>';
      }
    }
    function renderBranches() {
      const head = '<div class="unit-type-row head" style="grid-template-columns:1fr 76px;"><span>' + t('branches.colName') + '</span><span></span></div>';
      const body = factoriesItems.map((f) => '<div class="unit-type-row" style="grid-template-columns:1fr 76px;"><span>' + esc(f.name) + '</span><div class="unit-type-actions">' +
        '<button class="icon-action" type="button" title="Изменить" data-edit-branch="' + esc(f.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
        '<button class="icon-action danger" type="button" title="Удалить" data-delete-branch="' + esc(f.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>' +
        '</div></div>').join('');
      document.getElementById('branchesList').innerHTML = head + (body || '<div class="empty-admin">' + t('common.empty') + '</div>');
    }
    function openBranch(f) {
      document.getElementById('branchId').value = f ? f.id : '';
      document.getElementById('branchTitle').textContent = f ? 'Изменить филиал' : 'Новый филиал';
      document.getElementById('branchName').value = f ? f.name : '';
      document.getElementById('branchErr').textContent = '';
      document.getElementById('branchModal').classList.remove('hidden');
      document.getElementById('branchName').focus();
    }
    function closeBranch() { document.getElementById('branchModal').classList.add('hidden'); }
    document.getElementById('addBranch').addEventListener('click', () => openBranch(null));
    document.getElementById('branchCancel').addEventListener('click', closeBranch);
    document.getElementById('branchesList').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-branch]');
      if (editBtn) { openBranch(factoriesItems.find((f) => f.id === editBtn.dataset.editBranch)); return; }
      const delBtn = event.target.closest('[data-delete-branch]');
      if (delBtn) {
        if (!confirm('Удалить этот филиал?')) return;
        try { await coreApi('/admin/factories/' + encodeURIComponent(delBtn.dataset.deleteBranch), 'DELETE'); toast('Удалено'); await ensureBranches(); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
      }
    });
    document.getElementById('branchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('branchId').value;
      const payload = { name: document.getElementById('branchName').value.trim() };
      const save = document.getElementById('branchSave');
      const error = document.getElementById('branchErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/admin/factories/' + encodeURIComponent(id), 'PUT', payload);
        else await coreApi('/admin/factories', 'POST', payload);
        toast(id ? 'Филиал обновлён' : 'Филиал добавлен');
        closeBranch();
        await ensureBranches();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── namenklatura (product catalog) ── */
    let namenklaturaItems = [];
    let namenklaturaLoaded = false;
    async function ensureNamenklatura(force = false) {
      try {
        const tasks = [coreApi('/admin/materials'), loadUnitTypes()];
        if (!namenklaturaLoaded || force) {
          const [items] = await Promise.all(tasks);
          namenklaturaItems = items;
          namenklaturaLoaded = true;
        } else {
          await loadUnitTypes();
        }
        renderNamenklatura();
      } catch (err) {
        namenklaturaGrid.showError(err instanceof Error ? err.message : 'Не удалось загрузить номенклатуру');
      }
    }
    const namenklaturaGrid = createDataGrid({
      tableId: 'namenklaturaTable',
      hostId: 'namenklaturaHost',
      simple: true,
      searchPlaceholder: 'Поиск по коду, названию или категории…',
      defaultSortKey: 'sku',
      source: () => namenklaturaItems,
      columns: [
        { key:'sku', i18n:'namenklatura.colCode', width:110 },
        { key:'name', i18n:'namenklatura.colNameRu', width:220 },
        { key:'nameUz', i18n:'namenklatura.colNameUz', width:220 },
        { key:'nameTr', i18n:'namenklatura.colNameTr', width:220 },
        { key:'category', i18n:'namenklatura.colCategory', width:200 },
        { key:'defaultUnit', i18n:'namenklatura.colUnit', width:110 },
      ],
      actions: (m) => '<div class="row-actions-cell">' + (hasPermission('settings.manage','materials.manage') ?
        '<button class="icon-action" type="button" title="Изменить" data-edit-material="' + esc(m.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
        '<button class="icon-action danger" type="button" title="Удалить" data-delete-material="' + esc(m.id) + '"><i class="ti ti-trash" aria-hidden="true"></i></button>' : '') + '</div>',
    });
    function renderNamenklatura() { namenklaturaGrid.render(); }
    function fillMaterialUnitSelect(current) {
      const select = document.getElementById('materialUnit');
      select.innerHTML = '<option value="">—</option>' + unitTypesItems.map((u) => '<option value="' + esc(u.nameRu) + '">' + esc(unitLabel(u)) + '</option>').join('');
      select.value = current || '';
    }
    function fillMaterialCategoryList() {
      const categories = [...new Set(namenklaturaItems.map((m) => m.category).filter(Boolean))].sort();
      document.getElementById('materialCategoryList').innerHTML = categories.map((c) => '<option value="' + esc(c) + '"></option>').join('');
    }
    function openMaterial(m) {
      document.getElementById('materialId').value = m ? m.id : '';
      document.getElementById('materialTitle').textContent = m ? 'Изменить товар' : 'Новый товар';
      document.getElementById('materialCode').value = m ? m.sku || '' : '';
      document.getElementById('materialCategory').value = m ? m.category || '' : '';
      document.getElementById('materialNameRu').value = m ? m.name || '' : '';
      document.getElementById('materialNameUz').value = m ? m.nameUz || '' : '';
      document.getElementById('materialNameTr').value = m ? m.nameTr || '' : '';
      ['materialNameRu', 'materialNameUz', 'materialNameTr'].forEach((id) => autoExpand(document.getElementById(id)));
      fillMaterialCategoryList();
      fillMaterialUnitSelect(m ? m.defaultUnit : '');
      document.getElementById('materialErr').textContent = '';
      document.getElementById('materialModal').classList.remove('hidden');
      document.getElementById('materialCode').focus();
    }
    function closeMaterial() { document.getElementById('materialModal').classList.add('hidden'); }
    document.getElementById('addMaterial').addEventListener('click', () => openMaterial(null));
    wireExcelImport('importMaterial', 'importMaterialFile', '/admin/materials/import', () => ensureNamenklatura(true));
    document.getElementById('materialCancel').addEventListener('click', closeMaterial);
    document.getElementById('namenklaturaHost').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-material]');
      if (editBtn) { openMaterial(namenklaturaItems.find((m) => m.id === editBtn.dataset.editMaterial)); return; }
      const delBtn = event.target.closest('[data-delete-material]');
      if (delBtn) {
        if (!confirm('Удалить этот товар?')) return;
        try { await coreApi('/admin/materials/' + encodeURIComponent(delBtn.dataset.deleteMaterial), 'DELETE'); toast('Удалено'); await ensureNamenklatura(true); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось удалить'); }
      }
    });
    document.getElementById('materialForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('materialId').value;
      const payload = {
        sku: document.getElementById('materialCode').value.trim(),
        name: document.getElementById('materialNameRu').value.trim() || document.getElementById('materialCode').value.trim(),
        nameUz: document.getElementById('materialNameUz').value.trim(),
        nameTr: document.getElementById('materialNameTr').value.trim(),
        category: document.getElementById('materialCategory').value.trim(),
        defaultUnit: document.getElementById('materialUnit').value,
      };
      const save = document.getElementById('materialSave');
      const error = document.getElementById('materialErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/admin/materials/' + encodeURIComponent(id), 'PUT', payload);
        else await coreApi('/admin/materials', 'POST', payload);
        toast(id ? 'Товар обновлён' : 'Товар добавлен');
        closeMaterial();
        await ensureNamenklatura(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── postavshiki (suppliers) ── */
    let suppliersItems = [];
    let suppliersLoaded = false;
    async function ensureSuppliers(force = false) {
      if (suppliersLoaded && !force) return renderSuppliers();
      try {
        suppliersItems = await coreApi('/suppliers');
        suppliersLoaded = true;
        renderSuppliers();
      } catch (err) {
        suppliersGrid.showError(err instanceof Error ? err.message : 'Не удалось загрузить поставщиков');
      }
    }
    const suppliersGrid = createDataGrid({
      tableId: 'suppliersTable',
      hostId: 'suppliersHost',
      simple: true,
      searchPlaceholder: 'Поиск по названию, ИНН или контакту…',
      defaultSortKey: 'name',
      source: () => suppliersItems,
      columns: [
        { key:'name', i18n:'suppliers.colName', width:200 },
        { key:'inn', i18n:'suppliers.colInn', width:130 },
        { key:'phone', i18n:'suppliers.colPhone', width:150 },
        { key:'email', i18n:'suppliers.colEmail', width:200 },
        { key:'contactPerson', i18n:'suppliers.colContact', width:170 },
        { key:'category', i18n:'suppliers.colCategory', width:150 },
        { key:'rating', i18n:'suppliers.colRating', width:100, numeric:true },
      ],
      actions: (s) => '<div class="row-actions-cell">' + (hasPermission('suppliers.manage') ?
        '<button class="icon-action" type="button" title="Изменить" data-edit-supplier="' + esc(s.id) + '"><i class="ti ti-pencil" aria-hidden="true"></i></button>' +
        '<button class="icon-action danger" type="button" title="Архивировать" data-delete-supplier="' + esc(s.id) + '"><i class="ti ti-archive" aria-hidden="true"></i></button>' : '') + '</div>',
    });
    function renderSuppliers() { suppliersGrid.render(); }
    function openSupplier(s) {
      document.getElementById('supplierId').value = s ? s.id : '';
      document.getElementById('supplierTitle').textContent = s ? 'Изменить поставщика' : 'Новый поставщик';
      document.getElementById('supplierName').value = s ? s.name || '' : '';
      document.getElementById('supplierInn').value = s ? s.inn || '' : '';
      document.getElementById('supplierPhone').value = s ? s.phone || '' : '';
      document.getElementById('supplierEmail').value = s ? s.email || '' : '';
      document.getElementById('supplierContact').value = s ? s.contactPerson || '' : '';
      document.getElementById('supplierCategory').value = s ? s.category || '' : '';
      document.getElementById('supplierRating').value = s && s.rating != null ? s.rating : '';
      document.getElementById('supplierNote').value = s ? s.note || '' : '';
      document.getElementById('supplierErr').textContent = '';
      document.getElementById('supplierModal').classList.remove('hidden');
      document.getElementById('supplierName').focus();
    }
    function closeSupplier() { document.getElementById('supplierModal').classList.add('hidden'); }
    document.getElementById('addSupplier').addEventListener('click', () => openSupplier(null));
    document.getElementById('supplierCancel').addEventListener('click', closeSupplier);
    document.getElementById('suppliersHost').addEventListener('click', async (event) => {
      const editBtn = event.target.closest('[data-edit-supplier]');
      if (editBtn) { openSupplier(suppliersItems.find((s) => s.id === editBtn.dataset.editSupplier)); return; }
      const delBtn = event.target.closest('[data-delete-supplier]');
      if (delBtn) {
        if (!confirm('Архивировать этого поставщика?')) return;
        try { await coreApi('/suppliers/' + encodeURIComponent(delBtn.dataset.deleteSupplier), 'DELETE'); toast('Архивировано'); await ensureSuppliers(true); }
        catch (err) { toast(err instanceof Error ? err.message : 'Не удалось архивировать'); }
      }
    });
    document.getElementById('supplierForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('supplierId').value;
      const payload = {
        name: document.getElementById('supplierName').value.trim(),
        inn: document.getElementById('supplierInn').value.trim(),
        phone: document.getElementById('supplierPhone').value.trim(),
        email: document.getElementById('supplierEmail').value.trim(),
        contactPerson: document.getElementById('supplierContact').value.trim(),
        category: document.getElementById('supplierCategory').value.trim(),
        rating: document.getElementById('supplierRating').value ? Number(document.getElementById('supplierRating').value) : null,
        note: document.getElementById('supplierNote').value.trim(),
      };
      const save = document.getElementById('supplierSave');
      const error = document.getElementById('supplierErr');
      error.textContent = '';
      save.disabled = true;
      try {
        if (id) await coreApi('/suppliers/' + encodeURIComponent(id), 'PATCH', payload);
        else await coreApi('/suppliers', 'POST', payload);
        toast(id ? 'Поставщик обновлён' : 'Поставщик добавлен');
        closeSupplier();
        await ensureSuppliers(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally { save.disabled = false; }
    });

    /* ── create view ── */
    const form = { type:'', origin:'local', priority:'normal', items:[], step:1 };
    function emptyItem() { return { name:'', code:'', qty:'', unit:'', price:'', pay:'Банк', nds:false, note:'' }; }
    function createSelectText(id) {
      const field = document.getElementById(id);
      return field && field.selectedOptions && field.selectedOptions[0] ? field.selectedOptions[0].textContent.trim() : '—';
    }
    function renderCreateReview() {
      const liveItems = form.items.filter((item) => item.name.trim());
      const type = (meta.types || []).find((item) => item.value === form.type);
      const priority = (meta.priorities || []).find((item) => item.value === form.priority);
      const itemLines = liveItems.map((item, index) =>
        (index + 1) + '. ' + item.name.trim() + (item.code ? ' · ' + item.code : '') + ' — ' + item.qty + ' ' + (item.unit || '')
      ).join('\\n');
      document.getElementById('createReview').innerHTML =
        '<div class="create-review-block"><strong>Тип заявки</strong><span>' + esc((type || {}).label || form.type) + '</span></div>' +
        '<div class="create-review-block"><strong>Заявитель</strong><span>' + esc(createSelectText('fRequester')) + '</span></div>' +
        '<div class="create-review-block"><strong>Отдел</strong><span>' + esc(createSelectText('fDepartment')) + '</span></div>' +
        '<div class="create-review-block"><strong>Срочность / дата</strong><span>' + esc(((priority || {}).label || form.priority) + (document.getElementById('fNeeded').value ? ' · ' + document.getElementById('fNeeded').value : '')) + '</span></div>' +
        '<div class="create-review-block full"><strong>Продукты</strong><span>' + esc(itemLines || '—') + '</span></div>' +
        '<div class="create-review-block full"><strong>Комментарий</strong><span>' + esc(document.getElementById('fComment').value.trim() || '—') + '</span></div>';
    }
    function validateCreateStep(step) {
      const error = document.getElementById('formErr');
      error.textContent = '';
      if (step === 1 && (!form.type || !document.getElementById('fRequester').value)) {
        error.textContent = 'Выберите тип заявки и заявителя';
        return false;
      }
      if (step === 2) {
        const liveItems = form.items.filter((item) => item.name.trim());
        if (!liveItems.length) { error.textContent = 'Добавьте хотя бы один продукт'; return false; }
        const invalid = liveItems.find((item) => !(Number(item.qty) > 0));
        if (invalid) { error.textContent = 'Укажите количество больше нуля: ' + invalid.name; return false; }
      }
      return true;
    }
    function syncCreateStep() {
      form.step = Math.max(1, Math.min(3, Number(form.step) || 1));
      for (const panel of document.querySelectorAll('[data-create-step]')) {
        panel.classList.toggle('hidden', Number(panel.dataset.createStep) !== form.step);
      }
      for (const indicator of document.querySelectorAll('[data-create-step-indicator]')) {
        const step = Number(indicator.dataset.createStepIndicator);
        indicator.classList.toggle('active', step === form.step);
        indicator.classList.toggle('done', step < form.step);
      }
      document.getElementById('createBack').classList.toggle('hidden', form.step === 1);
      document.getElementById('createNext').classList.toggle('hidden', form.step === 3);
      document.getElementById('formSubmit').classList.toggle('hidden', form.step !== 3);
      if (form.step === 3) renderCreateReview();
      document.getElementById('formErr').textContent = '';
      document.getElementById('viewCreate').scrollIntoView({ block:'start', behavior:'smooth' });
    }
    async function ensureMeta() {
      if (meta) return;
      try {
        meta = await api('meta');
        materials = meta.materials || materials;
        renderProductCodeList();
        buildForm();
      } catch (err) {
        document.getElementById('formErr').textContent = err instanceof Error ? err.message : 'Ошибка загрузки справочников';
      }
    }
    function fillSelect(id, options, valueKey, labelKey, empty) {
      const sel = document.getElementById(id);
      sel.innerHTML = (empty ? '<option value="">—</option>' : '') +
        options.map((o) => '<option value="' + esc(o[valueKey]) + '">' + esc(o[labelKey]) + '</option>').join('');
    }
    function requesterDepartmentLabel(user) {
      return (user.departments || []).map((department) => localized(department, 'name', 'nameUz', 'nameTr')).filter(Boolean).join(', ');
    }
    function syncRequesterDepartment(preferredDepartmentId) {
      const requesterId = document.getElementById('fRequester').value;
      const requester = (meta.users || []).find((user) => user.id === requesterId);
      const configured = requester && Array.isArray(requester.departments) ? requester.departments : [];
      const choices = configured.length ? configured : (meta.departments || []);
      fillSelect('fDepartment', choices.map((department) => ({ id:department.id, label:localized(department,'name','nameUz','nameTr') })), 'id', 'label', true);
      const preferred = preferredDepartmentId && choices.some((department) => department.id === preferredDepartmentId) ? preferredDepartmentId : '';
      document.getElementById('fDepartment').value = preferred || (configured[0] || {}).id || '';
    }
    function openNativeDatePicker(event) {
      const field = event.currentTarget;
      if (!field || field.type !== 'date') return;
      try { if (typeof field.showPicker === 'function') field.showPicker(); } catch (_) { /* normal date focus remains available */ }
    }
    function buildForm() {
      form.type = (meta.types[0] || {}).value || 'material_request';
      const tg = document.getElementById('typeGrid');
      tg.innerHTML = meta.types.map((t) =>
        '<div class="type-card' + (t.value === form.type ? ' selected' : '') + '" data-type="' + esc(t.value) + '">' + esc(t.label) + '</div>'
      ).join('');
      tg.addEventListener('click', (e) => {
        const card = e.target.closest('[data-type]');
        if (!card) return;
        form.type = card.dataset.type;
        for (const c of tg.children) c.classList.toggle('selected', c === card);
        syncMaterialOnly();
      });
      fillSelect('fRequester', meta.users.map((user) => {
        const departmentLabel = requesterDepartmentLabel(user);
        return { id:user.id, label:departmentLabel ? user.name + ' · ' + departmentLabel : user.name };
      }), 'id', 'label', false);
      document.getElementById('fRequester').value = session.user.id;
      document.getElementById('fRequester').disabled = !hasPermission('users.manage');
      syncRequesterDepartment('');
      document.getElementById('fRequester').addEventListener('change', () => syncRequesterDepartment(''));
      document.getElementById('fNeeded').addEventListener('click', openNativeDatePicker);
      document.getElementById('fNeeded').addEventListener('focus', openNativeDatePicker);
      fillSelect('fObject', meta.objects, 'value', 'label', true);
      fillSelect('fWarehouse', meta.warehouses.map((w) => ({ v:w.id, l:localized(w,'name','nameUz','nameTr') })), 'v', 'l', true);
      fillSelect('fPurpose', meta.purposes, 'value', 'label', true);
      const op = document.getElementById('originPills');
      op.innerHTML = meta.origins.map((o) =>
        '<button class="pill' + (o.value === form.origin ? ' sel-plain' : '') + '" data-origin="' + esc(o.value) + '" type="button">' + esc(o.label) + '</button>'
      ).join('');
      op.addEventListener('click', (e) => {
        const p = e.target.closest('[data-origin]');
        if (!p) return;
        form.origin = p.dataset.origin;
        for (const c of op.children) c.classList.toggle('sel-plain', c === p);
      });
      const up = document.getElementById('urgencyPills');
      up.innerHTML = meta.priorities.map((o) =>
        '<button class="pill" data-priority="' + esc(o.value) + '" type="button">' + esc(o.label) + '</button>'
      ).join('');
      up.addEventListener('click', (e) => {
        const p = e.target.closest('[data-priority]');
        if (!p) return;
        form.priority = p.dataset.priority;
        syncUrgency();
      });
      form.items = [emptyItem()];
      form.step = 1;
      renderItems();
      syncUrgency();
      syncMaterialOnly();
      restoreCreateDraft();
      syncCreateStep();
    }
    function syncMaterialOnly() {
      const material = form.type.indexOf('material') === 0;
      document.getElementById('whField').style.display = material ? '' : 'none';
      document.getElementById('originField').style.display = material ? '' : 'none';
    }
    function syncUrgency() {
      const emergency = form.priority === 'urgent' || form.priority === 'critical';
      for (const p of document.querySelectorAll('[data-priority]')) {
        const sel = p.dataset.priority === form.priority;
        p.classList.toggle('sel-plain', sel && p.dataset.priority === 'normal');
        p.classList.toggle('sel-urgent', sel && p.dataset.priority === 'high');
        p.classList.toggle('sel-emergency', sel && (p.dataset.priority === 'urgent' || p.dataset.priority === 'critical'));
      }
      document.getElementById('emergencyWarning').classList.toggle('show', emergency);
      document.getElementById('formSubmit').textContent = emergency ? 'Отправить как аварийную →' : 'Отправить заявку →';
    }
    function renderItems() {
      const tb = document.getElementById('itemsBody');
      tb.innerHTML = form.items.map((it, i) =>
        '<tr data-i="' + i + '">' +
        '<td class="idx">' + (i + 1) + '</td>' +
        '<td><input data-f="name" list="productTitleList" autocomplete="off" placeholder="Например: Хлопковая пряжа 40/1" value="' + esc(it.name) + '"/></td>' +
        '<td><input data-f="code" list="productCodeList" autocomplete="off" placeholder="Код" value="' + esc(it.code) + '"/></td>' +
        '<td><input data-f="qty" type="number" min="0" placeholder="0" value="' + esc(it.qty) + '"/></td>' +
        '<td><select data-f="unit"><option value="">—</option>' + meta.units.map((u) => '<option value="' + esc(u.value) + '"' + (u.value === it.unit ? ' selected' : '') + '>' + esc(localized(u, 'name', 'nameUz', 'nameTr') || u.label || u.value) + '</option>').join('') + '</select></td>' +
        '<td><input data-f="price" type="number" min="0" placeholder="—" value="' + esc(it.price) + '"/></td>' +
        '<td><select data-f="pay"><option' + (it.pay === 'Банк' ? ' selected' : '') + '>Банк</option><option' + (it.pay === 'Нал.' ? ' selected' : '') + '>Нал.</option></select></td>' +
        '<td><label class="nds-cell-control"><input data-f="nds" type="checkbox"' + (it.nds ? ' checked' : '') + '/><span>НДС</span></label></td>' +
        '<td><textarea data-f="note" rows="1" placeholder="—">' + esc(it.note) + '</textarea></td>' +
        '<td><button class="row-x" data-action="rm" type="button"' + (form.items.length <= 1 ? ' disabled' : '') + '>×</button></td>' +
        '</tr>'
      ).join('');
      for (const field of tb.querySelectorAll('textarea[data-f]')) {
        field.style.height = 'auto';
        field.style.height = Math.max(34, field.scrollHeight) + 'px';
      }
      recalcTotal();
    }
    function recalcTotal() {
      const total = form.items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0), 0);
      document.getElementById('fTotal').textContent = money(total) + ' UZS';
    }
    document.getElementById('itemsBody').addEventListener('input', (e) => {
      const cell = e.target.closest('[data-f]');
      if (!cell) return;
      const i = Number(cell.closest('tr').dataset.i);
      form.items[i][cell.dataset.f] = cell.type === 'checkbox' ? cell.checked : cell.value;
      if (cell.tagName === 'TEXTAREA') {
        cell.style.height = 'auto';
        cell.style.height = Math.max(34, cell.scrollHeight) + 'px';
      }
      if (cell.dataset.f === 'code') {
        const material = productByCode(cell.value);
        if (material) {
          const row = cell.closest('tr');
          const title = materialTitleFor(material);
          form.items[i].code = material.code;
          form.items[i].name = title;
          if (material.unit) form.items[i].unit = material.unit;
          cell.value = material.code;
          row.querySelector('[data-f="name"]').value = title;
          if (material.unit) row.querySelector('[data-f="unit"]').value = material.unit;
        }
      }
      if (cell.dataset.f === 'name') {
        const material = productByTitle(cell.value);
        if (material) {
          const row = cell.closest('tr');
          const title = materialTitleFor(material);
          form.items[i].code = material.code;
          form.items[i].name = title;
          if (material.unit) form.items[i].unit = material.unit;
          cell.value = title;
          row.querySelector('[data-f="code"]').value = material.code;
          if (material.unit) row.querySelector('[data-f="unit"]').value = material.unit;
        }
      }
      if (cell.dataset.f === 'qty' || cell.dataset.f === 'price') recalcTotal();
    });
    document.getElementById('itemsBody').addEventListener('change', (e) => {
      const cell = e.target.closest('select[data-f]');
      if (!cell) return;
      form.items[Number(cell.closest('tr').dataset.i)][cell.dataset.f] = cell.value;
    });
    document.getElementById('itemsBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="rm"]');
      if (!btn) return;
      form.items.splice(Number(btn.closest('tr').dataset.i), 1);
      if (!form.items.length) form.items.push(emptyItem());
      renderItems();
    });
    document.getElementById('addRow').addEventListener('click', () => { form.items.push(emptyItem()); renderItems(); });
    document.getElementById('formSubmit').addEventListener('click', async () => {
      const errEl = document.getElementById('formErr');
      errEl.textContent = '';
      if (!validateCreateStep(2)) return;
      const btn = document.getElementById('formSubmit');
      btn.disabled = true;
      try {
        const requesterId = document.getElementById('fRequester').value;
        const dashboardPayload = {
          requesterId,
          requestType: form.type,
          departmentId: document.getElementById('fDepartment').value,
          lang: currentLang(),
          warehouseId: form.type.indexOf('material') === 0 ? document.getElementById('fWarehouse').value : '',
          obyekt: document.getElementById('fObject').value,
          origin: form.type.indexOf('material') === 0 ? form.origin : '',
          purpose: document.getElementById('fPurpose').value,
          priority: form.priority,
          neededDate: document.getElementById('fNeeded').value,
          comment: document.getElementById('fComment').value,
          items: form.items,
        };
        const canonicalPayload = {
          requestType:dashboardPayload.requestType,
          departmentId:dashboardPayload.departmentId || null,
          warehouseId:dashboardPayload.warehouseId || null,
          priority:dashboardPayload.priority,
          neededDate:dashboardPayload.neededDate || null,
          title:form.items.map((item) => item.name.trim()).filter(Boolean).slice(0,3).join(', ') || 'Новая заявка',
          description:dashboardPayload.comment || null,
           customFields:{obyekt:dashboardPayload.obyekt,origin:dashboardPayload.origin,purpose:dashboardPayload.purpose},
           items:form.items.filter((item) => item.name.trim()).map((item) => ({
             name:item.name.trim(), materialId:(productByCode(item.code) || productByTitle(item.name) || {}).id || null,
             quantity:Number(item.qty), unitPrice:Number(item.price) || 0,
            unit:item.unit || null, paymentType:item.pay || null, ndsIncluded:!!item.nds,
            description:[item.code ? 'Код товара: ' + item.code : '',item.note ? 'Примечание: ' + item.note : ''].filter(Boolean).join('\\n') || null,
          })),
        };
        // Ordinary dashboard creation uses the canonical API, so workflow,
        // notifications, audit and validation are identical to Telegram Web App.
        // The dashboard-only route remains for the explicit admin-on-behalf case.
        const out = requesterId === session.user.id
          ? await coreApi('/requests', 'POST', canonicalPayload)
          : await api('requests', dashboardPayload);
        form.items = [emptyItem()];
        form.step = 1;
        renderItems();
        document.getElementById('fComment').value = '';
        document.getElementById('fNeeded').value = '';
        requestsLoaded = false;
        await load();
        syncCreateStep();
        toast('Заявка создана: ' + out.requestNumber + '. Можно создать следующую.');
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : 'Не удалось создать заявку';
      } finally {
        btn.disabled = false;
      }
    });

    /* ── shared chrome ── */
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('loginErr');
      const submit = document.getElementById('loginSubmit');
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = 'Проверяем доступ…';
      try {
        const auth = await loginAccount(document.getElementById('username').value.trim(), document.getElementById('password').value);
        setToken(auth.token);
        await enterApp();
      } catch (err) {
        clearToken();
        error.textContent = err instanceof Error ? err.message : 'Ошибка входа';
        document.getElementById('password').select();
      } finally {
        submit.disabled = false;
        submit.textContent = 'Войти в систему';
      }
    });
    document.getElementById('forcePasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('forcePasswordErr');
      const submit = document.getElementById('forcePasswordSubmit');
      const p1 = document.getElementById('forcePassword1').value;
      const p2 = document.getElementById('forcePassword2').value;
      error.textContent = '';
      if (p1.length < 8) { error.textContent = 'Пароль должен содержать минимум 8 символов'; return; }
      if (p1 !== p2) { error.textContent = 'Пароли не совпадают'; return; }
      submit.disabled = true;
      try {
        await api('auth/set-password', { password: p1 });
        document.getElementById('forcePassword1').value = '';
        document.getElementById('forcePassword2').value = '';
        await enterApp();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить пароль';
      } finally {
        submit.disabled = false;
      }
    });
    document.getElementById('menuToggle').addEventListener('click', () => {
      const next = !document.body.classList.contains('sidebar-open');
      document.body.classList.toggle('sidebar-open', next);
      document.getElementById('menuToggle').setAttribute('aria-label', next ? 'Закрыть меню' : 'Открыть меню');
    });
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
    document.getElementById('columnFilterPopover').addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => {
      for (const panel of document.querySelectorAll('[data-grid-columns-panel]')) panel.classList.add('hidden');
      closeColumnFilter();
    });
    document.getElementById('columnFilterPopover').addEventListener('input', (event) => {
      if (event.target.id === 'columnFilterSearch') renderColumnFilterValues(event.target.value);
    });
    document.getElementById('columnFilterPopover').addEventListener('change', (event) => {
      const input = event.target.closest('[data-filter-value]');
      if (!input) return;
      if (input.checked) filterDraft.add(input.dataset.filterValue);
      else filterDraft.delete(input.dataset.filterValue);
    });
    document.getElementById('columnFilterPopover').addEventListener('click', (event) => {
      const command = event.target.closest('[data-filter-command]')?.dataset.filterCommand;
      if (!command) return;
      if (command === 'close') closeColumnFilter();
      if (command === 'all') { filterDraft = new Set(activeFilterOptions().map((option) => option.value)); renderColumnFilterValues(document.getElementById('columnFilterSearch').value); }
      if (command === 'none') { filterDraft = new Set(); renderColumnFilterValues(document.getElementById('columnFilterSearch').value); }
      if (command === 'sort-asc' || command === 'sort-desc') {
        const grid = activeFilterGrid;
        const key = activeFilterKey;
        closeColumnFilter();
        if (grid && grid.sortBy) grid.sortBy(key, command === 'sort-asc' ? 'asc' : 'desc');
      }
      if (command === 'clear') {
        const grid = activeFilterGrid;
        const key = activeFilterKey;
        closeColumnFilter();
        if (grid) { delete grid.filters[key]; grid.onChange(); }
      }
      if (command === 'apply') applyColumnFilter();
    });
    document.getElementById('togglePassword').addEventListener('click', () => {
      const input = document.getElementById('password');
      const next = input.type === 'password' ? 'text' : 'password';
      input.type = next;
      document.getElementById('togglePassword').setAttribute('aria-label', next === 'password' ? 'Показать пароль' : 'Скрыть пароль');
    });
    document.getElementById('procurementHost').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      btn.disabled = true;
      try {
        if (btn.dataset.action === 'edit') openRowEdit(tr.dataset.itemId);
        if (btn.dataset.action === 'delete') {
          pendingDeleteRow = tr;
          document.getElementById('confirmModal').classList.remove('hidden');
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Ошибка');
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('rowEditCancel').addEventListener('click', closeRowEdit);
    document.getElementById('rowEditModal').addEventListener('click', (event) => {
      if (event.target.id === 'rowEditModal') closeRowEdit();
    });
    document.getElementById('rowEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = document.getElementById('rowEditSave');
      const error = document.getElementById('rowEditErr');
      error.textContent = '';
      btn.disabled = true;
      try {
        await saveRowEdit();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить';
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('cancelDelete').addEventListener('click', () => {
      pendingDeleteRow = null;
      document.getElementById('confirmModal').classList.add('hidden');
    });
    document.getElementById('confirmDelete').addEventListener('click', async () => {
      const tr = pendingDeleteRow;
      pendingDeleteRow = null;
      document.getElementById('confirmModal').classList.add('hidden');
      if (!tr) return;
      try { await deleteRow(tr); } catch (err) { toast(err instanceof Error ? err.message : 'Ошибка'); }
    });
    document.getElementById('logout').addEventListener('click', () => {
      clearToken();
      location.reload();
    });
    setLang(currentLang());
    if (token()) {
      enterApp()
        .catch((err) => {
          if (err && err.status === 401) clearToken();
        });
    }
  </script>
</body>
</html>`;
}

export function buildSnabDashboardRouter(db: Db, sessionSecret: string): Router {
  const r = Router();
  const dashboardViews = new Set(['overview', 'procurement', 'requests', 'create', 'people', 'roles', 'workflow', 'namenklatura', 'suppliers', 'unit-types', 'departments', 'warehouses', 'branches']);

  r.get('/assets/tabler-icons.min.css', (_req: Request, res: Response) => {
    res.type('text/css').send(TABLER_ICON_CSS);
  });
  r.get('/assets/icons/:name.svg', (req: Request, res: Response) => {
    const name = String(req.params.name || '');
    if (!TABLER_ICON_SET.has(name)) {
      res.status(404).end();
      return;
    }
    res.type('image/svg+xml').sendFile(`${TABLER_ASSET_ROOT}icons/outline/${name}.svg`);
  });

  r.get('/', (_req: Request, res: Response) => {
    res.type('html').send(pageHtml());
  });

  // History-API entry points: every dashboard page serves the same application
  // shell, then the client restores the matching view after authentication.
  r.get('/:view', (req: Request, res: Response) => {
    if (!dashboardViews.has(String(req.params.view))) {
      res.status(404).end();
      return;
    }
    res.type('html').send(pageHtml());
  });

  r.post('/api/auth/login', async (req: Request, res: Response) => {
    const body = req.body as { username?: unknown; password?: unknown } | undefined;
    const user = await authenticateDashboardUser(db, body?.username, body?.password, sessionSecret);
    if (!user) {
      res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
      return;
    }
    const permissions = await getUserPermissionCodes(db, user.id);
    res.json({
      token: issueSession(user.id, sessionSecret, 12 * 60 * 60),
      user: { id: user.id, fullName: user.fullName, username: user.username, holdingId: user.holdingId },
      permissions,
      mustChangePassword: !!user.mustChangePassword,
    });
  });

  r.post('/api/me', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret);
    if (!actor) return;
    const branches = actor.holdingId ? await fetchUserBranches(db, actor.id, actor.holdingId) : [];
    const roleRows = await db
      .select({ code: schema.roles.code })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(and(eq(schema.userRoles.userId, actor.id), eq(schema.userRoles.status, 'active')));
    res.json({
      user: { id: actor.id, fullName: actor.fullName, username: actor.username, holdingId: actor.holdingId },
      permissions: actor.permissions,
      roleCodes: [...new Set(roleRows.map((role: { code: string }) => role.code))],
      branches,
      canSeeMoney: MONEY_PERMS.some((p) => actor.permissions.includes(p)),
      mustChangePassword: actor.mustChangePassword,
    });
  });

  /** Self-service password change — reachable even while mustChangePassword is
   *  pending (no permission requirement beyond a valid session): the account's
   *  existing password already grants access, this just replaces an
   *  admin-assigned one with a self-chosen one before continuing. */
  r.post('/api/auth/set-password', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret);
    if (!actor) return;
    const password = String((req.body ?? {}).password ?? '');
    if (password.length < 8) {
      res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов' });
      return;
    }
    await db
      .update(schema.users)
      .set({ passwordHash: hashPassword(password, sessionSecret), mustChangePassword: false, updatedAt: new Date() })
      .where(eq(schema.users.id, actor.id));
    res.json({ ok: true });
  });

  r.post('/api/data', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.view', 'requests.view_own']);
    if (!actor) return;
    const rows = await fetchDashboardRows(db, actor.holdingId, {
      requesterId: actor.id,
      viewAll: actor.permissions.includes('requests.view'),
    });
    // This registry is the same amounts the canonical API already hides behind
    // MONEY_PERMS (procurement/finance/audit) — the dashboard must not leak
    // them just because someone can see the request rows themselves.
    const canSeeMoney = MONEY_PERMS.some((p) => actor.permissions.includes(p));
    const visibleRows = canSeeMoney
      ? rows
      : rows.map((row) => ({ ...row, unitPrice: 0, amount: 0, usdAmount: 0, amountWithNds: 0, usdAmountWithNds: 0 }));
    res.json({ rows: visibleRows, materials: await fetchDashboardMaterials(db, actor.holdingId), canSeeMoney });
  });

  r.post('/api/meta', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.create']);
    if (!actor) return;
    res.json(await fetchCreateMeta(db, actor.holdingId, actor.id));
  });

  r.post('/api/requests', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.create']);
    if (!actor) return;
    try {
      const body = req.body as CreateBody;
      const requesterId = text(body.requesterId).trim() || actor.id;
      if (requesterId !== actor.id && !actor.permissions.includes('users.manage')) {
        res.status(403).json({ error: 'Создавать заявку от имени другого пользователя может только администратор' });
        return;
      }
      const out = await createFromDashboard(db, actor.holdingId, { ...body, requesterId });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message || 'Не удалось создать заявку' });
    }
  });

  r.put('/api/row/:itemId', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['procurement.quote', 'requests.edit', 'settings.manage']);
    if (!actor) return;
    try {
      await updateDashboardRow(
        db,
        actor.holdingId,
        String(req.params.itemId),
        (req.body as { row?: unknown } | undefined)?.row,
        (req.body as { lang?: unknown } | undefined)?.lang,
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message || 'Dashboard row not found' });
    }
  });

  r.delete('/api/row/:itemId', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.edit', 'settings.manage']);
    if (!actor) return;
    try {
      await deleteDashboardRow(db, actor.holdingId, String(req.params.itemId));
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message || 'Dashboard row not found' });
    }
  });

  return r;
}
