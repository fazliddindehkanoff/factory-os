import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { eq, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { issueSession, verifySession } from '../auth/session.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';
import { createRequest } from '../services/request.service.js';

type Db = any;

interface DashboardActor {
  id: string;
  holdingId: string;
  username: string;
  fullName: string;
  permissions: string[];
}

interface DashboardRow {
  itemId: string;
  requestId: string;
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

async function updateDashboardRow(db: Db, holdingId: string, itemId: string, patch: unknown): Promise<void> {
  const row = normalizeUpdate(patch);
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

async function fetchCreateMeta(db: Db, holdingId: string): Promise<Record<string, unknown>> {
  const usersRes = await db.execute(sql`
    SELECT id, full_name FROM users
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY full_name ASC
  `);
  const deptRes = await db.execute(sql`
    SELECT id, name FROM departments
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY name ASC
  `);
  const whRes = await db.execute(sql`
    SELECT name FROM warehouses
    WHERE holding_id = ${holdingId} AND status = 'active'
    ORDER BY name ASC
  `);
  const ffRes = await db.execute(sql`
    SELECT field_key, options FROM form_fields
    WHERE holding_id = ${holdingId} AND screen = 'request_create' AND enabled = true
  `);
  const users = (Array.isArray(usersRes) ? usersRes : usersRes.rows ?? []).map((u: any) => ({ id: text(u.id), name: text(u.full_name) }));
  const departments = (Array.isArray(deptRes) ? deptRes : deptRes.rows ?? []).map((d: any) => ({ id: text(d.id), name: text(d.name) }));
  const warehouses = (Array.isArray(whRes) ? whRes : whRes.rows ?? []).map((w: any) => text(w.name));
  const ff = new Map<string, unknown>();
  for (const f of (Array.isArray(ffRes) ? ffRes : ffRes.rows ?? []) as any[]) ff.set(text(f.field_key), f.options);

  return {
    holdingId,
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
    units: optionList(ff.get('unit')).length ? optionList(ff.get('unit')) : ['шт', 'кг', 'г', 'л', 'м', 'т', 'м²', 'рулон', 'упак'].map((u) => ({ value: u, label: u })),
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
      note: text(it?.note).trim(),
    }))
    .filter((it) => it.name);
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
        quantity: it.qty,
        unitPrice: it.price,
        unit: it.unit || null,
        description: lines.length ? lines.join('\n') : null,
      };
    }),
  });

  // Банк/Нал per line — request_items.payment_type is not part of the create
  // service input, so set it right after (the table reads this column).
  for (const it of items) {
    if (!it.pay) continue;
    await db.execute(sql`
      UPDATE request_items SET payment_type = ${it.pay}
      WHERE request_id = ${req.id} AND name = ${it.name}
    `);
  }
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
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');
    :root{
      --bg:#080D19; --bg-elev:#0A0F1D; --card:rgba(255,255,255,0.04); --card-hover:rgba(255,255,255,0.06);
      --border:rgba(255,255,255,0.10); --border-strong:rgba(255,255,255,0.20);
      --text:#FFFFFF; --text-sec:#94A3B8; --text-muted:#64748B;
      --accent1:#6366F1; --accent2:#22D3EE;
      --green:#22C55E; --green-bg:rgba(34,197,94,0.13); --green-bd:rgba(34,197,94,0.35);
      --amber:#F59E0B; --amber-bg:rgba(245,158,11,0.13); --amber-bd:rgba(245,158,11,0.35);
      --red:#EF4444; --red-bg:rgba(239,68,68,0.13); --red-bd:rgba(239,68,68,0.35);
      --radius-card:16px; --radius-ctl:10px;
    }
    body[data-theme="light"]{
      --bg:#F1F5F9; --bg-elev:#FFFFFF; --card:#FFFFFF; --card-hover:#F8FAFC;
      --border:#E2E8F0; --border-strong:#CBD5E1;
      --text:#0F172A; --text-sec:#475569; --text-muted:#94A3B8;
      --accent1:#4F46E5; --accent2:#0891B2;
      color-scheme:light;
    }
    *{box-sizing:border-box;}
    body{margin:0;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;color-scheme:dark;}
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
    .side-link{display:flex;align-items:center;justify-content:space-between;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:10px;background:none;color:var(--text-sec);font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background .12s,color .12s;}
    .side-label{display:flex;align-items:center;gap:9px;min-width:0;}
    .side-link:hover{background:rgba(255,255,255,0.05);color:var(--text);}
    .side-link.active{background:rgba(99,102,241,0.15);color:#A5B4FC;font-weight:600;}
    .side-link svg{flex:0 0 auto;}
    .side-badge{min-width:18px;height:18px;padding:0 6px;border-radius:99px;background:var(--amber);color:#fff;font-size:10px;font-weight:800;line-height:18px;text-align:center;}
    .module-preview-btn{opacity:.82;}
    .module-preview-btn:hover{opacity:1;}
    .side-bottom{margin-top:auto;border-top:1px solid var(--border);padding-top:12px;}
    .side-user{display:flex;align-items:center;gap:9px;margin:0 5px 10px;padding:8px 5px;min-width:0;}
    .side-avatar{width:30px;height:30px;display:grid;place-items:center;flex:none;border-radius:9px;background:rgba(99,102,241,.18);color:#C7D2FE;font-size:11px;font-weight:700;}
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
    .topbar-control,.icon-btn{height:38px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.04);color:var(--text-sec);display:inline-flex;align-items:center;gap:7px;padding:0 11px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
    .topbar-control:hover,.icon-btn:hover{background:var(--card-hover);color:var(--text);}
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
    .kpi-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .kpi-icon{width:34px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(99,102,241,.16);color:#A5B4FC;font:10px 'JetBrains Mono',ui-monospace,monospace;}
    .k{color:var(--text-sec);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;}
    .v{font-size:24px;font-weight:600;margin-top:7px;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .trend{margin-top:5px;color:var(--text-muted);font-size:11px;font-weight:700;}
    .trend.bad{color:var(--red);}
    .trend.good{color:var(--green);}
    .ops-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
    .ops-panel{min-height:190px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:16px 18px;overflow:hidden;}
    .ops-panel-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-size:14px;font-weight:800;}
    .panel-link{border:0;background:transparent;color:#A5B4FC;font-size:12px;font-weight:700;cursor:pointer;}
    .pipeline{display:grid;grid-template-columns:repeat(7,1fr);align-items:end;gap:10px;height:132px;padding-top:10px;}
    .pipe-day{display:grid;grid-template-rows:1fr auto;gap:7px;min-width:0;text-align:center;color:var(--text-muted);font-size:10.5px;font-weight:700;}
    .pipe-bars{height:100%;display:flex;align-items:end;justify-content:center;gap:3px;}
    .pipe-bar{width:7px;min-height:6px;border-radius:7px 7px 2px 2px;background:var(--accent1);}
    .pipe-bar.approved{background:var(--green);}
    .pipe-bar.closed{background:var(--amber);}
    .compact-list{display:grid;gap:8px;}
    .compact-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.025);}
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
    .settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:12;width:min(430px,calc(100vw - 36px));max-height:min(520px,70vh);overflow:auto;padding:14px;border:1px solid var(--border-strong);border-radius:14px;background:#0E1526;box-shadow:0 20px 54px rgba(0,0,0,.42);}
    .settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;}
    .settings-head strong{display:block;font-size:13px;}
    .settings-head span{display:block;margin-top:2px;color:var(--text-muted);font-size:11px;}
    .settings-actions{display:flex;gap:6px;flex-wrap:wrap;}
    .columns-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
    .column-option{display:flex;align-items:flex-start;gap:7px;padding:8px;border:1px solid var(--border);border-radius:9px;background:rgba(255,255,255,.025);color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .column-option input{margin-top:2px;}
    .filters-panel{display:none;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:14px;margin-bottom:14px;}
    .filters-panel.open{display:block;}
    .filters-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;}
    .filter-field label{display:block;margin-bottom:4px;color:var(--text-muted);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}
    .filter-row{display:grid;grid-template-columns:1fr;gap:6px;}
    .filter-field select{width:100%;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:9px;padding:7px 9px;font-size:12px;outline:none;}
    .filter-field select[data-filter-mode]{height:34px;appearance:none;-webkit-appearance:none;color:var(--text-sec);background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 7px center;background-size:14px;padding-right:24px;}
    .filter-field select[data-filter-key]{min-height:92px;color:var(--text);}
    .filter-field select[data-filter-key] option{padding:4px 6px;border-radius:6px;}
    .filter-field select option{background:#0A0F1D;color:var(--text);}
    .filter-field select:focus{border-color:var(--accent1);}
    /* table */
    .table-shell{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;}
    .scroll{overflow:auto;max-height:calc(100vh - 320px);}
    table{border-collapse:separate;border-spacing:0;min-width:2750px;width:100%;font-size:12.5px;}
    th,td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:9px 10px;white-space:nowrap;text-align:left;}
    th{position:sticky;top:33px;z-index:2;background:#111a30;font-weight:600;color:var(--text-sec);font-size:11.5px;}
    th.group{top:0;background:#0A0F1D;color:#A5B4FC;text-align:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;}
    .sort-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0;}
    .sort-head:hover{color:var(--text);}
    .sort-mark{flex:none;color:var(--text-muted);font-size:10px;}
    .sort-head.active .sort-mark{color:var(--accent2);}
    tr:nth-child(even) td{background:rgba(255,255,255,0.015);}
    .num{text-align:right;font-variant-numeric:tabular-nums;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .actions{display:flex;gap:6px;}
    .mini{border:1px solid var(--border);border-radius:9px;padding:6px 9px;background:transparent;color:var(--text-sec);font-weight:600;font-size:12px;cursor:pointer;}
    .mini:hover{background:var(--card-hover);}
    .mini.save{color:var(--green);}
    .mini.delete{color:var(--red);}
    .dirty td{background:rgba(245,158,11,0.08) !important;}
    .table-empty{padding:38px 18px;color:var(--text-muted);text-align:center;}
    .table-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-top:1px solid var(--border);background:rgba(10,15,29,.72);flex-wrap:wrap;}
    .pager-info{color:var(--text-sec);font-size:12px;}
    .pager-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .pager-actions select{height:32px;border:1px solid var(--border);border-radius:9px;background:rgba(255,255,255,.03);color:var(--text-sec);padding:0 8px;outline:none;}
    .pager-actions select option{background:#0A0F1D;color:var(--text);}
    .pager-btn{min-width:32px;height:32px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--text-sec);cursor:pointer;}
    .pager-btn:hover:not(:disabled){border-color:var(--border-strong);background:var(--card-hover);color:var(--text);}
    .pager-btn:disabled{opacity:.38;cursor:not-allowed;}
    /* ── create view (ported from the confirmed «Новая заявка» mock) ── */
    .form-wrap{max-width:980px;}
    .fcard{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:22px 24px;margin-bottom:18px;}
    .fcard-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;margin:0 0 16px;}
    .num-badge{width:22px;height:22px;border-radius:7px;background:rgba(99,102,241,0.18);color:#A5B4FC;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;}
    .fcard-title small{font-weight:400;font-size:12px;color:var(--text-muted);margin-left:4px;}
    label.f{display:block;font-size:12px;color:var(--text-sec);margin-bottom:6px;font-weight:500;}
    label.f .req{color:var(--red);}
    .field{margin-bottom:14px;}
    .field-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:14px;}
    .fin,select.fin,textarea.fin{width:100%;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-ctl);padding:10px 12px;font-size:13.5px;outline:none;transition:border-color .12s;}
    .fin:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    select.fin{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 10px center;background-size:16px;padding-right:32px;}
    select.fin option{background:#0A0F1D;color:var(--text);}
    textarea.fin{resize:vertical;min-height:70px;}
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
    .warning-banner{display:none;align-items:flex-start;gap:10px;background:var(--red-bg);border:1px solid var(--red-bd);color:#FCA5A5;border-radius:12px;padding:12px 14px;margin-top:12px;font-size:12.5px;}
    .warning-banner.show{display:flex;}
    .items-shell{border:1px solid var(--border);border-radius:14px;overflow-x:auto;}
    table.items{min-width:820px;width:100%;font-size:13px;border-collapse:separate;border-spacing:0;}
    table.items th{position:static;background:transparent;color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;padding:10px 8px;border-bottom:1px solid var(--border);border-right:none;}
    table.items td{padding:5px 6px;border-bottom:1px solid var(--border);border-right:none;vertical-align:middle;}
    table.items tr:last-child td{border-bottom:none;}
    table.items input,table.items select{width:100%;border:1px solid transparent;background:transparent;border-radius:8px;padding:7px 8px;font-size:13px;outline:none;}
    table.items input:hover,table.items select:hover{border-color:var(--border);}
    table.items input:focus,table.items select:focus{border-color:var(--accent1);background:rgba(255,255,255,0.03);}
    table.items select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 6px center;background-size:14px;padding-right:22px;}
    table.items select option{background:#0A0F1D;}
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
    .err-line{color:#FCA5A5;font-size:12.5px;min-height:18px;margin-bottom:8px;}
    /* ── access administration ── */
    .admin-stats{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));gap:12px;margin-bottom:16px;}
    .admin-stat{padding:15px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card);}
    .admin-stat strong{display:block;margin-bottom:2px;font-size:23px;font-weight:600;}
    .admin-stat span{color:var(--text-muted);font-size:11.5px;}
    .admin-panel{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--card);}
    .admin-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);}
    .admin-panel-head strong{font-size:13px;}
    .admin-search{width:min(310px,45vw);padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);outline:none;}
    .admin-search:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,.13);}
    .people-list{min-width:720px;}
    .people-row{display:grid;grid-template-columns:minmax(210px,1.25fr) minmax(150px,.9fr) minmax(210px,1.25fr) 100px 96px;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--border);}
    .people-row:last-child{border-bottom:0;}
    .people-row.head{color:var(--text-muted);font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.015);}
    .identity{display:flex;align-items:center;gap:10px;min-width:0;}
    .avatar{width:34px;height:34px;display:grid;place-items:center;flex:none;border-radius:10px;background:linear-gradient(135deg,rgba(99,102,241,.24),rgba(34,211,238,.15));color:#C7D2FE;font-size:11px;font-weight:700;}
    .identity-name{overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;}
    .identity-meta{overflow:hidden;color:var(--text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap;}
    .role-list{display:flex;gap:5px;flex-wrap:wrap;}
    .role-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid rgba(99,102,241,.22);border-radius:999px;background:rgba(99,102,241,.10);color:#C7D2FE;font-size:10.5px;}
    .status-dot{display:inline-flex;align-items:center;gap:6px;color:var(--text-sec);font-size:11.5px;}
    .status-dot:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--text-muted);}
    .status-dot.active:before{background:var(--green);box-shadow:0 0 0 3px var(--green-bg);}
    .mini-action{padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,.035);color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .mini-action:hover{border-color:var(--border-strong);color:var(--text);}
    .mini-action.danger{border-color:var(--red-bd);background:var(--red-bg);color:#FCA5A5;}
    .mini-action:disabled{opacity:.55;cursor:wait;}
    .empty-admin{padding:42px 20px;color:var(--text-muted);text-align:center;}
    .roles-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;}
    .role-card{min-height:170px;padding:16px;border:1px solid var(--border);border-radius:15px;background:var(--card);}
    .role-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:13px;}
    .role-card h3{margin:0;font-size:14px;}
    .role-code{margin-top:3px;color:var(--text-muted);font:10.5px 'IBM Plex Mono',ui-monospace,monospace;}
    .role-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;}
    .role-count{padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.05);color:var(--text-sec);font-size:10px;white-space:nowrap;}
    .role-perms{display:flex;gap:5px;flex-wrap:wrap;max-height:72px;overflow:hidden;}
    .perm-chip{padding:3px 6px;border-radius:6px;background:rgba(34,211,238,.07);color:#A5D8E5;font:9.5px 'IBM Plex Mono',ui-monospace,monospace;}
    .modal.wide{width:min(680px,100%);max-height:calc(100dvh - 36px);overflow:auto;}
    .modal-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .modal-field{margin-bottom:12px;}
    .modal-field label{display:block;margin-bottom:6px;color:var(--text-sec);font-size:11.5px;font-weight:600;}
    .modal-field.full{grid-column:1/-1;}
    .row-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .row-edit-grid .modal-field{margin-bottom:0;}
    .permission-groups{display:grid;gap:10px;margin-top:12px;}
    .permission-group{padding:11px;border:1px solid var(--border);border-radius:11px;}
    .permission-group-title{margin-bottom:8px;color:#C7D2FE;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;}
    .permission-options{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
    .permission-option{display:flex;align-items:flex-start;gap:7px;color:var(--text-sec);font-size:11.5px;cursor:pointer;}
    .permission-option input{margin-top:2px;}
    /* ── shared request workflow ── */
    .request-tabs{display:flex;gap:5px;padding:4px;border:1px solid var(--border);border-radius:11px;background:rgba(255,255,255,.025);}
    .request-tab{padding:7px 11px;border:0;border-radius:8px;background:transparent;color:var(--text-sec);font-size:11.5px;font-weight:600;cursor:pointer;}
    .request-tab.active{background:rgba(99,102,241,.18);color:#C7D2FE;}
    .request-list{display:grid;gap:8px;}
    .request-row{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(130px,.7fr) minmax(120px,.65fr) minmax(110px,.55fr) 26px;align-items:center;gap:16px;padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card);cursor:pointer;transition:border-color .12s,background .12s,translate .12s;}
    .request-row:hover{border-color:var(--border-strong);background:var(--card-hover);translate:0 -1px;}
    .request-number{color:#A5B4FC;font:10.5px 'IBM Plex Mono',ui-monospace,monospace;}
    .request-title{margin-top:3px;font-size:13.5px;font-weight:600;}
    .request-meta{color:var(--text-muted);font-size:11px;}
    .request-status{display:inline-flex;width:max-content;padding:5px 8px;border:1px solid rgba(99,102,241,.23);border-radius:999px;background:rgba(99,102,241,.09);color:#C7D2FE;font-size:10.5px;font-weight:600;}
    .request-priority{font-size:11.5px;color:var(--text-sec);}
    .request-priority.high,.request-priority.urgent,.request-priority.critical{color:var(--amber);}
    .request-arrow{color:var(--text-muted);font-size:18px;text-align:right;}
    .modal.detail-modal{width:min(940px,100%);max-height:calc(100dvh - 28px);overflow:auto;padding:0;}
    .detail-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:19px 20px;border-bottom:1px solid var(--border);background:rgba(14,21,38,.96);backdrop-filter:blur(8px);}
    .detail-head h2{margin:3px 0 0;font-size:20px;}
    .icon-close{width:36px;height:36px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);color:var(--text-sec);cursor:pointer;}
    .detail-body{padding:18px 20px 22px;}
    .detail-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px;}
    .detail-cell{padding:10px 11px;border:1px solid var(--border);border-radius:11px;background:rgba(255,255,255,.025);}
    .detail-cell span{display:block;margin-bottom:4px;color:var(--text-muted);font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;}
    .detail-cell strong{font-size:12px;font-weight:600;}
    .detail-section{margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:13px;background:rgba(255,255,255,.02);}
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
    .timeline-dot{position:relative;z-index:1;width:13px;height:13px;margin-top:2px;border:2px solid var(--text-muted);border-radius:50%;background:#0E1526;}
    .timeline-step.completed .timeline-dot{border-color:var(--green);background:var(--green);}
    .timeline-step.current .timeline-dot{border-color:var(--accent1);box-shadow:0 0 0 4px rgba(99,102,241,.14);}
    .timeline-step.rejected .timeline-dot,.timeline-step.returned .timeline-dot{border-color:var(--red);background:var(--red);}
    .timeline-name{font-size:11.5px;font-weight:600;}
    .timeline-meta{margin-top:2px;color:var(--text-muted);font-size:10.5px;}
    .detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px;}
    .action-btn{padding:10px 13px;border:1px solid rgba(99,102,241,.28);border-radius:10px;background:rgba(99,102,241,.14);color:#C7D2FE;font-size:11.5px;font-weight:650;cursor:pointer;}
    .action-btn.danger{border-color:var(--red-bd);background:var(--red-bg);color:#FCA5A5;}
    .action-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}
    .action-fields .full{grid-column:1/-1;}
    .quote-list,.quote-item-fields{display:grid;gap:8px;}
    .quote-card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.02);font-size:11.5px;}
    .quote-card.selected{border-color:var(--green-bd);background:var(--green-bg);}
    .quote-item-fields label{display:grid;grid-template-columns:minmax(180px,1fr) minmax(130px,.45fr);align-items:center;gap:10px;color:var(--text-sec);font-size:11.5px;}
    /* misc */
    .toast{position:fixed;right:18px;bottom:18px;max-width:min(420px,calc(100vw - 36px));border:1px solid var(--border-strong);border-radius:12px;background:#111827;padding:12px 15px;font-weight:500;z-index:40;box-shadow:0 8px 24px rgba(0,0,0,0.4);}
    .modal-backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:18px;background:rgba(4,7,14,.6);z-index:30;}
    .modal{width:min(420px,100%);border-radius:16px;background:#0E1526;border:1px solid var(--border);padding:20px;}
    .modal h2{margin:0 0 8px;font-size:17px;}
    .modal p{margin:0 0 16px;color:var(--text-sec);font-size:13px;}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;}
    .err{color:#FCA5A5;font-size:13px;min-height:18px;}
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
      .scroll{max-height:calc(100vh - 340px);}
      .topbar-control{display:none;}
      .search-wrap{width:min(460px,58vw);}
    }
    @media (min-width:761px){ .mobile-search{display:none;} }
  </style>
</head>
<body>
  <main id="login" class="login">
    <div class="login-shell">
      <section class="login-story" aria-label="Factory OS procurement console">
        <div class="login-brand">
          <span class="login-brand-mark" aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M5 19V9l7-4 7 4v10M9 19v-5h6v5M8 10h.01M12 10h.01M16 10h.01" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
              <span class="login-input-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
              <input class="login-input" id="username" name="username" type="text" placeholder="Например, snab.admin" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
            </div>
          </div>
          <div class="login-field">
            <label for="password">Пароль</label>
            <div class="login-input-wrap">
              <span class="login-input-icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
              <input class="login-input" id="password" name="password" type="password" placeholder="Введите пароль" autocomplete="current-password" required />
              <button class="eye" id="togglePassword" type="button" aria-label="Показать пароль">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>
              </button>
            </div>
          </div>
          <div class="err" id="loginErr" role="alert" aria-live="polite"></div>
          <button class="btn login-submit" id="loginSubmit" type="submit">Войти в систему</button>
          <div class="login-note">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.2 8.2-8 10-4.8-1.8-8-5-8-10V6l8-3Z" stroke="currentColor" stroke-width="1.8"/><path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Сессия хранится только в этой вкладке браузера.
          </div>
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
        <div class="nav-sec">Меню</div>
        <button class="side-link active" data-view="overview" id="navOverview" type="button" aria-label="Дашборд">
          <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 13h6V4H4v9Zm10 7h6V4h-6v16ZM4 20h6v-5H4v5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          Дашборд</span>
        </button>
        <button class="side-link" data-view="requests" id="navRequests" type="button">
          <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4h10M7 9h10M7 14h6M5 21h14a2 2 0 0 0 2-2V2H3v17a2 2 0 0 0 2 2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Заявки</span> <span class="side-badge" id="inboxBadge">0</span>
        </button>
        <button class="side-link" data-view="create" type="button" aria-label="Новая заявка">
          <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Новая заявка</span>
        </button>
        <div class="nav-sec">Операции</div>
        <button class="side-link" data-view="procurement" id="navProcurement" type="button" aria-label="Снабжение"><span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M6 6h15l-2 8H8L6 3H3m6 16a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Снабжение</span></button>
        <button class="side-link module-preview-btn" data-module="documents" data-module-title="Документы" data-module-note="Договоры, счета, вложения и закрывающие документы" type="button" aria-label="Документы"><span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 5h7l2 2h7v12H4V5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Документы</span></button>
        <button class="side-link module-preview-btn" data-module="suppliers" data-module-title="Поставщики" data-module-note="Риски, задержки, контакты и история закупок" type="button" aria-label="Поставщики"><span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M3 7h11v10H3V7Zm11 3h4l3 3v4h-7v-7ZM7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Поставщики</span></button>
        <button class="side-link module-preview-btn" data-module="reports" data-module-title="Отчёты" data-module-note="Бюджет vs факт, скорость маршрутов и поставщики" type="button" aria-label="Отчёты"><span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 19V9m7 10V5m7 14v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Отчёты</span></button>
        <div class="nav-sec hidden" id="adminNavLabel">Управление</div>
        <button class="side-link hidden" data-view="people" id="navPeople" type="button" aria-label="Пользователи">
          <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 18.5V20M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 8v6M14 11h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          Пользователи</span>
        </button>
        <button class="side-link hidden" data-view="roles" id="navRoles" type="button" aria-label="Роли и права">
          <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.2 8.2-8 10-4.8-1.8-8-5-8-10V6l8-3Z" stroke="currentColor" stroke-width="1.8"/><path d="M9 12h6M12 9v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          Роли и права</span>
        </button>
        <div class="side-bottom">
          <div class="side-user" id="sideUser">
            <span class="side-avatar" id="sideAvatar">—</span>
            <div style="min-width:0;"><div class="side-user-name" id="sideUserName">—</div><div class="side-user-login" id="sideUserLogin">—</div></div>
          </div>
          <button class="side-link" id="logout" type="button" aria-label="Выйти">
            <span class="side-label"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 12H4m0 0 3.5-3.5M4 12l3.5 3.5M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Выйти</span>
          </button>
        </div>
      </aside>
      <div class="backdrop" id="sidebarBackdrop"></div>
      <section class="main-pane">
        <header class="navbar">
          <div class="nav-left">
            <button class="menu-btn" id="menuToggle" type="button" aria-label="Открыть меню">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
            <div>
              <div class="brand-title" id="navTitle">Операционный дашборд</div>
              <div class="brand-sub" id="updated"></div>
            </div>
          </div>
          <div class="nav-actions">
            <div class="search-wrap" id="overviewActions" style="visibility:hidden">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m21 21-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              <input id="search" class="search" placeholder="Поиск заявок, документов, поставщиков..." />
            </div>
            <button class="topbar-control" id="factorySwitch" type="button"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 21V8l6 4V8l6 4V3h6v18H3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Zelal Textile</button>
            <div class="lang-wrap">
              <button class="topbar-control" id="langToggle" type="button"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M4 7h16M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span id="langLabel">RU</span></button>
              <div class="lang-menu hidden" id="langMenu"><button class="lang-option active" data-lang="RU" type="button">RU</button><button class="lang-option" data-lang="UZ" type="button">UZ</button><button class="lang-option" data-lang="EN" type="button">EN</button></div>
            </div>
            <button class="icon-btn" id="themeToggle" type="button" aria-label="Переключить тему"><svg id="themeIcon" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
            <button class="icon-btn" id="notifyButton" type="button" aria-label="Уведомления"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="notify-dot" id="notifyDot"></span></button>
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
            <div class="card kpi-card"><div class="kpi-head"><div class="k">Активные заявки</div><div class="kpi-icon">REQ</div></div><div class="v" id="kRequests">0</div><div class="trend" id="kRequestsTrend">В таблице закупок</div></div>
            <div class="card kpi-card"><div class="kpi-head"><div class="k">Требуют действия</div><div class="kpi-icon">OK</div></div><div class="v" id="kInbox">0</div><div class="trend bad" id="kInboxTrend">Ожидают решения</div></div>
            <div class="card kpi-card"><div class="kpi-head"><div class="k">Позиции</div><div class="kpi-icon">ROW</div></div><div class="v" id="kRows">0</div><div class="trend">Отфильтровано сейчас</div></div>
            <div class="card kpi-card"><div class="kpi-head"><div class="k">Сумма</div><div class="kpi-icon">UZS</div></div><div class="v" id="kAmount">0</div><div class="trend">UZS по видимым строкам</div></div>
            <div class="card kpi-card"><div class="kpi-head"><div class="k">Поставщиков</div><div class="kpi-icon">SUP</div></div><div class="v" id="kSuppliers">0</div><div class="trend good">Контрагенты в выборке</div></div>
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
              <div class="sub">Реестр закупок: сортировка, Excel-фильтры, пагинация и редактирование через модальное окно</div>
            </div>
            <input id="mobileSearch" class="search mobile-search" placeholder="Поиск..." />
          </div>
          <div class="table-heading">
            <div><h2>Реестр закупок</h2><div class="sub">Сортировка, Excel-фильтры, пагинация и редактирование через модальное окно</div></div>
          </div>
          <div class="toolbar">
            <button class="btn ghost" id="toggleFilters" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              Фильтры <span class="filter-count" id="filterCount">0</span>
            </button>
            <div class="settings-wrap">
              <button class="btn ghost" id="toggleTableSettings" type="button">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 4v16M16 4v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                Столбцы <span class="filter-count" id="columnCount">0</span>
              </button>
              <div class="settings-panel hidden" id="tableSettingsPanel">
                <div class="settings-head">
                  <div><strong>Настройки таблицы</strong><span>Показывайте только нужные поля в реестре.</span></div>
                  <div class="settings-actions">
                    <button class="mini-action" id="showDefaultColumns" type="button">По умолчанию</button>
                    <button class="mini-action" id="showAllColumns" type="button">Все</button>
                  </div>
                </div>
                <div class="columns-grid" id="columnSettings"></div>
              </div>
            </div>
            <button class="btn ghost" id="clearFilters" type="button">Очистить</button>
          </div>
          <section class="filters-panel" id="filtersPanel" aria-label="Фильтры таблицы">
            <div id="filters" class="filters-grid"></div>
          </section>
          <section class="table-shell">
            <div class="scroll"><table id="table"></table></div>
            <div class="table-pager" id="tablePager">
              <div class="pager-info" id="pagerInfo">Строк нет</div>
              <div class="pager-actions">
                <label class="pager-info" for="pageSize">Показывать</label>
                <select id="pageSize">
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="250">250</option>
                </select>
                <button class="pager-btn" id="firstPage" type="button" aria-label="Первая страница">«</button>
                <button class="pager-btn" id="prevPage" type="button" aria-label="Предыдущая страница">‹</button>
                <span class="pager-info" id="pageInfo">1 / 1</span>
                <button class="pager-btn" id="nextPage" type="button" aria-label="Следующая страница">›</button>
                <button class="pager-btn" id="lastPage" type="button" aria-label="Последняя страница">»</button>
              </div>
            </div>
          </section>
        </div>

        <!-- ── VIEW: canonical requests + personal action inbox ── -->
        <div class="wrap hidden" id="viewRequests">
          <div class="top">
            <div>
              <h1>Заявки и согласования</h1>
              <div class="sub">Тот же маршрут и те же действия, что в Telegram Web App</div>
            </div>
            <div class="request-tabs"><button class="request-tab active" data-request-mode="all" type="button">Все заявки</button><button class="request-tab" data-request-mode="inbox" type="button">Требуют действия <span id="inboxCount">0</span></button></div>
          </div>
          <div class="toolbar"><input class="search" id="requestSearch" placeholder="Номер или название заявки…" /><select class="fin" id="requestStatus" style="width:190px"><option value="">Все статусы</option><option value="pending_approval">На согласовании</option><option value="warehouse_check">Проверка склада</option><option value="procurement">Снабжение</option><option value="finance_payment">Оплата</option><option value="delivery">Доставка</option><option value="receiving">Приёмка</option><option value="closed">Закрыто</option><option value="rejected">Отклонено</option></select></div>
          <div class="request-list" id="requestList"><div class="empty-admin">Загрузка заявок…</div></div>
        </div>

        <!-- ── VIEW: create (ported from the confirmed «Новая заявка» mock) ── -->
        <div class="wrap hidden" id="viewCreate">
          <div class="top">
            <div>
              <h1>Новая заявка</h1>
              <div class="sub">Все поля — на одном экране · заявка попадает в общий маршрут согласования</div>
            </div>
          </div>
          <div class="form-wrap">
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
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px;" aria-hidden="true"><path d="M12 3l10 18H2L12 3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                <div>Аварийная заявка требует немедленного согласования — маршрут будет ускорен.</div>
              </div>
            </div>

            <div class="fcard">
              <div class="fcard-title"><span class="num-badge">3</span>Позиции<small>по строкам, как в бумажной заявке</small></div>
              <div class="items-shell">
                <table class="items">
                  <thead><tr>
                    <th style="width:34px;">№</th><th style="width:26%;">Наименование *</th><th style="width:12%;">Код</th>
                    <th style="width:9%;">Кол-во *</th><th style="width:10%;">Ед. изм</th><th style="width:12%;">Цена</th>
                    <th style="width:11%;">Банк/Нал</th><th>Примечание</th><th style="width:36px;"></th>
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

            <div class="err-line" id="formErr"></div>
            <div class="form-actions">
              <button class="btn ghost" id="formCancel" type="button">Отмена</button>
              <button class="btn" id="formSubmit" type="button">Отправить заявку →</button>
            </div>
          </div>
        </div>

        <!-- ── VIEW: shared users (dashboard + Telegram identities) ── -->
        <div class="wrap hidden" id="viewPeople">
          <div class="top">
            <div>
              <h1>Пользователи</h1>
              <div class="sub">Одна учётная запись для dashboard и Telegram Web App</div>
            </div>
            <button class="btn" id="addUser" type="button">+ Добавить пользователя</button>
          </div>
          <section class="admin-stats">
            <div class="admin-stat"><strong id="usersTotal">0</strong><span>Всего пользователей</span></div>
            <div class="admin-stat"><strong id="usersWeb">0</strong><span>Доступ к dashboard</span></div>
            <div class="admin-stat"><strong id="usersTelegram">0</strong><span>Связаны с Telegram</span></div>
          </section>
          <section class="admin-panel">
            <div class="admin-panel-head"><strong>Команда и доступ</strong><input class="admin-search" id="peopleSearch" placeholder="Поиск по имени или логину…" /></div>
            <div style="overflow-x:auto;"><div class="people-list" id="peopleList"><div class="empty-admin">Загрузка пользователей…</div></div></div>
          </section>
        </div>

        <!-- ── VIEW: roles + granular permissions ── -->
        <div class="wrap hidden" id="viewRoles">
          <div class="top">
            <div>
              <h1>Роли и права</h1>
              <div class="sub">Системные роли едины для dashboard и Telegram; собственные роли можно настраивать</div>
            </div>
            <button class="btn" id="addRole" type="button">+ Новая роль</button>
          </div>
          <div class="roles-grid" id="rolesGrid"><div class="empty-admin">Загрузка ролей…</div></div>
        </div>
      </section>
    </div>
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
        <p>Доступ к dashboard можно объединить с Telegram ID того же сотрудника.</p>
        <input id="accountId" type="hidden" />
        <div class="modal-form-grid">
          <div class="modal-field"><label for="accountName">Имя и фамилия</label><input class="fin" id="accountName" required /></div>
          <div class="modal-field"><label for="accountPosition">Должность</label><input class="fin" id="accountPosition" /></div>
          <div class="modal-field"><label for="accountUsername">Логин dashboard</label><input class="fin" id="accountUsername" autocomplete="off" required /></div>
          <div class="modal-field"><label for="accountPassword">Пароль <span id="passwordHint"></span></label><input class="fin" id="accountPassword" type="password" autocomplete="new-password" /></div>
          <div class="modal-field"><label for="accountTelegram">Telegram ID</label><input class="fin" id="accountTelegram" inputmode="numeric" /></div>
          <div class="modal-field"><label for="accountEmail">Email</label><input class="fin" id="accountEmail" type="email" /></div>
          <div class="modal-field"><label for="accountPhone">Телефон</label><input class="fin" id="accountPhone" /></div>
          <div class="modal-field"><label for="accountStatus">Статус</label><select class="fin" id="accountStatus"><option value="active">Активен</option><option value="suspended">Приостановлен</option><option value="disabled">Отключён</option></select></div>
          <div class="modal-field full"><label for="accountRole">Добавить роль</label><select class="fin" id="accountRole"><option value="">Без новой роли</option></select></div>
          <div class="modal-field full hidden" id="currentRolesWrap"><label>Назначенные роли</label><div class="role-list" id="accountRoles"></div></div>
        </div>
        <div class="err-line" id="accountErr"></div>
        <div class="modal-actions"><button class="btn ghost" id="accountCancel" type="button">Отмена</button><button class="btn" id="accountSave" type="submit">Создать пользователя</button></div>
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
    <div id="requestDetailModal" class="modal-backdrop hidden">
      <article class="modal detail-modal">
        <header class="detail-head"><div><div class="request-number" id="detailNumber">—</div><h2 id="detailTitle">Заявка</h2></div><button class="icon-close" id="detailClose" type="button" aria-label="Закрыть">×</button></header>
        <div class="detail-body" id="detailBody"><div class="empty-admin">Загрузка…</div></div>
      </article>
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
    let filtersReady = false;
    let meta = null;
    const fmt = new Intl.NumberFormat('ru-RU');
    const money = (v) => fmt.format(Math.round(Number(v) || 0));
    const numericKeys = new Set(['quantity','unitPrice','exchangeRate','amount','usdAmount','ndsRate','amountWithNds','usdAmountWithNds']);
    let pendingDeleteRow = null;
    let editingRow = null;
    let session = null;
    const tableState = { sortKey: 'date', sortDir: 'desc', page: 1, pageSize: 25 };
    let visibleColumnKeys = loadVisibleColumns();
    function token() { return sessionStorage.getItem('snab_dashboard_token') || ''; }
    function authHeaders() {
      const value = token();
      return {'Content-Type':'application/json', ...(value ? {Authorization:'Bearer ' + value} : {})};
    }
    function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    async function api(path, body) {
      const res = await fetch('/snab-dashboard/api/' + path, {
        method:'POST', headers:authHeaders(), body: JSON.stringify(body || {}),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 401) sessionStorage.removeItem('snab_dashboard_token');
      if (!res.ok) throw new Error(out.error || 'Ошибка запроса');
      return out;
    }
    async function loginAccount(username, password) {
      const res = await fetch('/snab-dashboard/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password}),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Ошибка входа');
      return out;
    }
    async function coreApi(path, method = 'GET', body) {
      const res = await fetch('/api' + path, {
        method, headers:authHeaders(), ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 401) sessionStorage.removeItem('snab_dashboard_token');
      if (!res.ok) throw new Error(out.error || 'Ошибка запроса');
      return out;
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
      document.getElementById('navOverview').classList.toggle('hidden', !canView);
      document.getElementById('navRequests').classList.toggle('hidden', !canView);
      document.getElementById('navProcurement').classList.toggle('hidden', !canView);
      document.querySelector('[data-view="create"]').classList.toggle('hidden', !canCreate);
      document.getElementById('adminNavLabel').classList.toggle('hidden', !canPeople && !canRoles);
      document.getElementById('navPeople').classList.toggle('hidden', !canPeople);
      document.getElementById('navRoles').classList.toggle('hidden', !canRoles);
      document.getElementById('addUser').classList.toggle('hidden', !canManagePeople);
      document.getElementById('addRole').classList.toggle('hidden', !canRoles);
      document.getElementById('sideUserName').textContent = session.user.fullName;
      document.getElementById('sideUserLogin').textContent = '@' + session.user.username;
      document.getElementById('sideAvatar').textContent = initials(session.user.fullName);
    }
    async function enterApp() {
      session = await api('me');
      applyAccess();
      if (hasPermission('requests.view','requests.view_own')) await Promise.all([load(), refreshInboxCount()]);
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      if (!hasPermission('requests.view','requests.view_own')) {
        if (hasPermission('users.view','users.manage')) showView('people');
        else if (hasPermission('roles.manage')) showView('roles');
      }
    }

    /* ── view switching (sidebar = navigation) ── */
    function showView(view) {
      const views = { overview:'viewOverview', procurement:'viewProcurement', requests:'viewRequests', create:'viewCreate', people:'viewPeople', roles:'viewRoles' };
      for (const [key, id] of Object.entries(views)) document.getElementById(id).classList.toggle('hidden', key !== view);
      const procurement = view === 'procurement';
      document.getElementById('overviewActions').style.visibility = procurement ? 'visible' : 'hidden';
      document.getElementById('navTitle').textContent = ({ overview:'Операционный дашборд', procurement:'Снабжение', requests:'Заявки и согласования', create:'Новая заявка', people:'Пользователи', roles:'Роли и права' })[view] || 'Factory OS';
      for (const link of document.querySelectorAll('.side-link[data-view]')) {
        link.classList.toggle('active', link.dataset.view === view);
      }
      if (view === 'create') ensureMeta();
      if (view === 'requests') ensureRequests();
      if (view === 'people') ensurePeople();
      if (view === 'roles') ensureRoleData();
      closeSidebar();
    }
    document.querySelectorAll('.side-link[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    document.querySelectorAll('[data-view-jump]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.viewJump)));
    function showModulePreview(button) {
      const title = button.dataset.moduleTitle || 'Модуль';
      const note = button.dataset.moduleNote || 'Раздел будет открыт отдельным рабочим экраном.';
      toast(title + ': ' + note);
    }
    document.querySelectorAll('[data-module]').forEach((b) => b.addEventListener('click', () => showModulePreview(b)));
    document.getElementById('formCancel').addEventListener('click', () => showView('overview'));
    document.getElementById('factorySwitch').addEventListener('click', () => toast('Сейчас выбран завод: Zelal Textile'));
    document.getElementById('notifyButton').addEventListener('click', () => showView('requests'));
    document.getElementById('langToggle').addEventListener('click', () => document.getElementById('langMenu').classList.toggle('hidden'));
    document.querySelectorAll('[data-lang]').forEach((button) => button.addEventListener('click', () => {
      document.getElementById('langLabel').textContent = button.dataset.lang;
      document.querySelectorAll('[data-lang]').forEach((item) => item.classList.toggle('active', item === button));
      document.getElementById('langMenu').classList.add('hidden');
      toast('Язык интерфейса: ' + button.dataset.lang);
    }));
    document.getElementById('themeToggle').addEventListener('click', () => {
      const light = document.body.dataset.theme !== 'light';
      document.body.dataset.theme = light ? 'light' : 'dark';
      localStorage.setItem('snab_dashboard_theme', document.body.dataset.theme);
    });
    document.body.dataset.theme = localStorage.getItem('snab_dashboard_theme') || 'dark';

    /* ── overview: search / filters / table ── */
    function activeSearch() {
      const desktop = document.getElementById('search').value.trim();
      const mobile = document.getElementById('mobileSearch').value.trim();
      return (desktop || mobile).toLowerCase();
    }
    function resetPageAndRender() {
      tableState.page = 1;
      render();
    }
    function syncSearch(value) {
      document.getElementById('search').value = value;
      document.getElementById('mobileSearch').value = value;
      resetPageAndRender();
    }
    function closeSidebar() {
      document.body.classList.remove('sidebar-open');
      document.getElementById('menuToggle').setAttribute('aria-label', 'Открыть меню');
    }
    function loadVisibleColumns() {
      try {
        const saved = JSON.parse(localStorage.getItem('snab_visible_columns') || 'null');
        const valid = Array.isArray(saved) ? saved.filter((key) => keys.includes(key)) : [];
        return new Set(valid.length ? valid : [...defaultVisibleKeys]);
      } catch {
        return new Set([...defaultVisibleKeys]);
      }
    }
    function visibleKeys() {
      const out = keys.filter((key) => visibleColumnKeys.has(key));
      return out.length ? out : ['requestNumber'];
    }
    function keyLabel(key) {
      return headers[keys.indexOf(key)] || key;
    }
    function saveVisibleColumns() {
      localStorage.setItem('snab_visible_columns', JSON.stringify([...visibleColumnKeys]));
    }
    function renderColumnSettings() {
      const hiddenCount = keys.length - visibleKeys().length;
      const badge = document.getElementById('columnCount');
      badge.textContent = hiddenCount;
      badge.style.display = hiddenCount ? 'inline-block' : 'none';
      document.getElementById('columnSettings').innerHTML = keys.map((key) =>
        '<label class="column-option"><input type="checkbox" data-column-key="' + key + '"' + (visibleColumnKeys.has(key) ? ' checked' : '') + '><span>' + esc(keyLabel(key)) + '</span></label>'
      ).join('');
    }
    function setVisibleColumns(next) {
      visibleColumnKeys = new Set(next.filter((key) => keys.includes(key)));
      if (!visibleColumnKeys.size) visibleColumnKeys.add('requestNumber');
      saveVisibleColumns();
      renderColumnSettings();
      render();
    }
    function visibleGroups(activeKeys) {
      const active = new Set(activeKeys);
      let offset = 0;
      const out = [];
      for (const [label, count] of groups) {
        const slice = keys.slice(offset, offset + count);
        const visibleCount = slice.filter((key) => active.has(key)).length;
        if (visibleCount) out.push([label, visibleCount]);
        offset += count;
      }
      return out;
    }
    function filterValues() {
      const out = {};
      for (const select of document.querySelectorAll('select[data-filter-key]')) {
        const values = [...select.selectedOptions].map((option) => option.value.trim().toLowerCase()).filter(Boolean);
        const mode = document.querySelector('[data-filter-mode="' + select.dataset.filterKey + '"]')?.value || 'in';
        if (values.length || mode === 'empty' || mode === 'filled') out[select.dataset.filterKey] = { mode, values };
      }
      return out;
    }
    function filterOptionsHtml(key) {
      const values = [...new Set(rows.map((row) => String(row[key] ?? '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'ru')).slice(0, 80);
      return values.map((value) => '<option value="' + esc(value) + '">' + esc(value) + '</option>').join('');
    }
    function renderFilters() {
      const previous = filterValues();
      const box = document.getElementById('filters');
      box.innerHTML = keys.map((key, i) =>
        '<div class="filter-field"><label>' + esc(headers[i]) + '</label><div class="filter-row">' +
        '<select data-filter-mode="' + key + '" aria-label="Тип фильтра: ' + esc(headers[i]) + '">' +
        '<option value="in">Любое из</option><option value="contains">Содержит</option><option value="empty">Пусто</option><option value="filled">Заполнено</option>' +
        '</select><select data-filter-key="' + key + '" multiple aria-label="Значения фильтра: ' + esc(headers[i]) + '">' + filterOptionsHtml(key) + '</select></div></div>'
      ).join('');
      for (const [key, filter] of Object.entries(previous)) {
        const mode = document.querySelector('[data-filter-mode="' + key + '"]');
        const select = document.querySelector('select[data-filter-key="' + key + '"]');
        if (mode) mode.value = filter.mode || 'in';
        if (select) for (const option of select.options) option.selected = (filter.values || []).includes(option.value.trim().toLowerCase());
      }
      if (!filtersReady) {
        box.addEventListener('change', resetPageAndRender);
        filtersReady = true;
      }
      renderColumnSettings();
    }
    function rowValue(r, key) { return String(r[key] ?? '').toLowerCase(); }
    function rowMatchesFilter(r, key, filter) {
      const value = rowValue(r, key);
      if (filter.mode === 'empty') return !value;
      if (filter.mode === 'filled') return !!value;
      if (!filter.values || !filter.values.length) return true;
      if (filter.mode === 'contains') return filter.values.some((needle) => value.includes(needle));
      return filter.values.includes(value);
    }
    function parseDateLike(value) {
      const text = String(value || '').trim();
      const match = text.match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
      if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? null : parsed;
    }
    function sortValue(row, key) {
      if (numericKeys.has(key)) return Number(row[key]) || 0;
      const asDate = parseDateLike(row[key]);
      if (asDate !== null) return asDate;
      return String(row[key] ?? '').toLowerCase();
    }
    function sortedRows(data) {
      const key = tableState.sortKey;
      if (!key) return data;
      const dir = tableState.sortDir === 'desc' ? -1 : 1;
      return [...data].sort((a, b) => {
        const av = sortValue(a, key);
        const bv = sortValue(b, key);
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), 'ru', { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    function headerHtml(key, label) {
      const active = tableState.sortKey === key;
      const mark = active ? (tableState.sortDir === 'asc' ? '▲' : '▼') : '↕';
      return '<th><button class="sort-head ' + (active ? 'active' : '') + '" type="button" data-sort-key="' + key + '" title="Сортировать по столбцу"><span>' + esc(label) + '</span><span class="sort-mark">' + mark + '</span></button></th>';
    }
    function updatePager(total) {
      const pageCount = Math.max(1, Math.ceil(total / tableState.pageSize));
      if (tableState.page > pageCount) tableState.page = pageCount;
      const start = total ? (tableState.page - 1) * tableState.pageSize + 1 : 0;
      const end = Math.min(total, tableState.page * tableState.pageSize);
      document.getElementById('pagerInfo').textContent = total ? 'Показаны ' + fmt.format(start) + '–' + fmt.format(end) + ' из ' + fmt.format(total) : 'Строк нет';
      document.getElementById('pageInfo').textContent = tableState.page + ' / ' + pageCount;
      document.getElementById('firstPage').disabled = tableState.page <= 1;
      document.getElementById('prevPage').disabled = tableState.page <= 1;
      document.getElementById('nextPage').disabled = tableState.page >= pageCount;
      document.getElementById('lastPage').disabled = tableState.page >= pageCount;
      document.getElementById('pageSize').value = String(tableState.pageSize);
      return pageCount;
    }
    function toast(message) {
      const el = document.getElementById('toast');
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
      const max = Math.max(1, ...groupedByDay(data).flatMap((d) => [d.created,d.approved,d.closed]));
      document.getElementById('pipelineBars').innerHTML = groupedByDay(data).map((d) =>
        '<div class="pipe-day"><div class="pipe-bars">' +
        '<span class="pipe-bar" style="height:' + Math.max(6, d.created / max * 100) + '%"></span>' +
        '<span class="pipe-bar approved" style="height:' + Math.max(6, d.approved / max * 100) + '%"></span>' +
        '<span class="pipe-bar closed" style="height:' + Math.max(6, d.closed / max * 100) + '%"></span>' +
        '</div><span>' + d.day + '</span></div>'
      ).join('');
    }
    function renderCompactPanels(data) {
      const missing = data.filter((row) => !row.warehouse || !row.supplier || !row.contractNumber).slice(0, 4);
      document.getElementById('recentActivity').innerHTML = data.slice(0, 5).map((row) =>
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
      document.getElementById('updated').textContent = 'Обновлено: ' + new Date().toLocaleString('ru-RU');
      renderFilters();
      render();
    }
    function render() {
      const q = activeSearch();
      const fv = filterValues();
      const fc = Object.keys(fv).length;
      const badge = document.getElementById('filterCount');
      badge.textContent = fc;
      badge.style.display = fc ? 'inline-block' : 'none';
      const data = rows.filter((r) => {
        if (q && !JSON.stringify(r).toLowerCase().includes(q)) return false;
        for (const [key, filter] of Object.entries(fv)) {
          if (!rowMatchesFilter(r, key, filter)) return false;
        }
        return true;
      });
      document.getElementById('kRows').textContent = fmt.format(data.length);
      document.getElementById('kRequests').textContent = fmt.format(new Set(data.map((r) => r.requestNumber).filter(Boolean)).size);
      document.getElementById('kAmount').textContent = money(data.reduce((sum, r) => sum + Number(r.amount || 0), 0));
      document.getElementById('kSuppliers').textContent = fmt.format(new Set(data.map((r) => r.supplier).filter(Boolean)).size);
      renderOpsDashboard(data);
      const sorted = sortedRows(data);
      updatePager(sorted.length);
      const pageRows = sorted.slice((tableState.page - 1) * tableState.pageSize, tableState.page * tableState.pageSize);
      const activeKeys = visibleKeys();
      const activeGroups = visibleGroups(activeKeys);
      const table = document.getElementById('table');
      table.style.minWidth = Math.max(980, activeKeys.length * 126 + 130) + 'px';
      table.innerHTML =
        '<thead><tr>' + activeGroups.map((g) => '<th class="group" colspan="' + g[1] + '">' + esc(g[0]) + '</th>').join('') + '<th class="group" colspan="1"></th></tr><tr>' +
        activeKeys.map((key) => headerHtml(key, keyLabel(key))).join('') + '<th>Действия</th></tr></thead><tbody>' +
        (pageRows.length ? pageRows.map((r) => '<tr data-item-id="' + esc(r.itemId) + '">' + activeKeys.map((k) => cellHtml(r, k)).join('') + actionsHtml(r) + '</tr>').join('') : '<tr><td colspan="' + (activeKeys.length + 1) + '"><div class="table-empty">Нет строк под выбранные фильтры</div></td></tr>') +
        '</tbody>';
    }
    function cellHtml(r, k) {
      const value = numericKeys.has(k) ? String(Math.round(Number(r[k]) || 0)) : String(r[k] ?? '');
      const cls = numericKeys.has(k) ? 'num' : '';
      return '<td class="' + cls + '">' + esc(numericKeys.has(k) ? money(value) : value) + '</td>';
    }
    function actionsHtml() {
      const edit = hasPermission('procurement.quote','requests.edit','settings.manage') ? '<button class="mini save" data-action="edit">Редактировать</button>' : '';
      const del = hasPermission('requests.edit','settings.manage') ? '<button class="mini delete" data-action="delete">Удалить</button>' : '';
      return '<td><div class="actions">' + edit + del + '</div></td>';
    }
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
        : '<input class="fin" data-row-edit-key="' + key + '" value="' + esc(String(value)) + '" />';
      return '<div class="modal-field"><label>' + esc(label) + '</label>' + input + '</div>';
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
    function closeRowEdit() {
      editingRow = null;
      document.getElementById('rowEditModal').classList.add('hidden');
    }
    async function saveRowEdit() {
      const itemId = document.getElementById('rowEditItemId').value;
      const res = await fetch('/snab-dashboard/api/row/' + encodeURIComponent(itemId), {
        method:'PUT', headers:authHeaders(), body: JSON.stringify({ row: rowPayloadFromModal() }),
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
        const data = await Promise.all([coreApi('/requests?limit=200'), coreApi('/requests/inbox?limit=200')]);
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
      const source = requestMode === 'inbox' ? inboxRows : requestRows;
      const data = source.filter((row) => {
        if (status && row.status !== status) return false;
        return !query || [row.requestNumber,row.title,row.requesterName,row.departmentName,row.departmentNameResolved,row.obyekt]
          .some((value) => String(value || '').toLowerCase().includes(query));
      });
      document.getElementById('requestList').innerHTML = data.map((row) => {
        const department = row.departmentName || row.departmentNameResolved || row.requesterName || 'Без отдела';
        const amount = row.estimatedAmount == null ? 'Сумма скрыта' : money(row.estimatedAmount) + ' UZS';
        const actions = Array.isArray(row.actions) && row.actions.length ? ' · ' + row.actions.length + ' действий' : '';
        return '<article class="request-row" data-request-id="' + esc(row.id) + '" tabindex="0">' +
          '<div><div class="request-number">' + esc(row.requestNumber || '—') + '</div><div class="request-title">' + esc(row.title || 'Без названия') + '</div><div class="request-meta">' + esc(department) + actions + '</div></div>' +
          '<div><span class="request-status">' + esc(requestStatus(row)) + '</span></div>' +
          '<div><div class="request-priority ' + esc(row.priority || 'normal') + '">' + esc(priorityLabels[row.priority] || row.priority || 'Обычный') + '</div><div class="request-meta">нужно к ' + esc(dateText(row.neededDate)) + '</div></div>' +
          '<div><div style="font-size:11.5px;font-weight:600">' + esc(amount) + '</div><div class="request-meta">' + esc(dateText(row.createdAt)) + '</div></div>' +
          '<div class="request-arrow">›</div></article>';
      }).join('') || '<div class="empty-admin">' + (requestMode === 'inbox' ? 'Нет заявок, ожидающих вашего действия' : 'Заявки не найдены') + '</div>';
    }
    document.querySelectorAll('[data-request-mode]').forEach((button) => button.addEventListener('click', () => {
      requestMode = button.dataset.requestMode;
      document.querySelectorAll('[data-request-mode]').forEach((tab) => tab.classList.toggle('active', tab === button));
      renderRequests();
    }));
    document.getElementById('requestSearch').addEventListener('input', renderRequests);
    document.getElementById('requestStatus').addEventListener('change', renderRequests);
    document.getElementById('requestList').addEventListener('click', (event) => {
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
    async function openRequest(id) {
      const modal = document.getElementById('requestDetailModal');
      modal.classList.remove('hidden');
      document.getElementById('detailNumber').textContent = 'Загрузка…';
      document.getElementById('detailTitle').textContent = 'Заявка';
      document.getElementById('detailBody').innerHTML = '<div class="empty-admin">Загрузка…</div>';
      try {
        currentRequest = await coreApi('/requests/' + encodeURIComponent(id));
        renderRequestDetail();
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
        return '<tr><td>' + (index + 1) + '</td><td><strong>' + esc(item.name || item.itemName || '—') + '</strong><div class="request-meta">' + esc(item.code || item.itemCode || '') + '</div></td><td>' + esc(String(item.quantity || 0) + ' ' + (item.unit || item.unitName || '')) + '</td><td>' + esc(price) + '</td><td>' + stock + '</td></tr>';
      }).join('');
      const custom = (row.customInfo || []).length ? '<section class="detail-section"><div class="detail-section-title">Дополнительно</div><div class="detail-summary">' + row.customInfo.map((item) => detailCell(item.label,item.value)).join('') + '</div></section>' : '';
      const quotes = (row.quotations || []).length ? '<section class="detail-section"><div class="detail-section-title">Коммерческие предложения</div><div class="quote-list">' + row.quotations.map((quote) => '<div class="quote-card ' + (quote.selected ? 'selected' : '') + '"><div><strong>' + esc(quote.supplierName || 'Поставщик не указан') + '</strong><div class="request-meta">' + esc(quote.paymentType || '') + '</div></div><div><strong>' + esc(money(quote.amount) + ' UZS') + '</strong>' + (quote.selected ? '<div class="request-meta">Выбрано</div>' : '') + '</div></div>').join('') + '</div></section>' : '';
      const timeline = (row.workflowTimeline || []).map((step) => '<div class="timeline-step ' + esc(step.state || 'future') + '"><span class="timeline-dot"></span><div><div class="timeline-name">' + esc(step.stepName || 'Этап') + '</div><div class="timeline-meta">' + esc([step.actorName,step.actorRole,dateText(step.at,true)].filter((value) => value && value !== '—').join(' · ') || (step.state === 'current' ? 'Текущий этап' : 'Ожидает')) + '</div>' + (step.comment ? '<div class="timeline-meta">«' + esc(step.comment) + '»</div>' : '') + '</div></div>').join('');
      const actions = (row.actions || []).map((action) => '<button class="action-btn ' + (/reject|return|cancel/.test(action.action) ? 'danger' : '') + '" type="button" data-request-action="' + esc(action.action) + '">' + esc(action.label) + '</button>').join('');
      document.getElementById('detailBody').innerHTML =
        '<div class="detail-summary">' + detailCell('Статус',requestStatus(row)) + detailCell('Автор',row.requesterName) + detailCell('Отдел',row.departmentNameResolved) + detailCell('Нужно к',dateText(row.neededDate)) + detailCell('Приоритет',priorityLabels[row.priority] || row.priority) + detailCell('Ответственный',row.responsibleName) + detailCell('Сумма',row.estimatedAmount == null ? 'Скрыта' : money(row.estimatedAmount) + ' UZS') + detailCell('Создана',dateText(row.createdAt,true)) + '</div>' +
        (row.description ? '<section class="detail-section"><div class="detail-section-title">Комментарий</div><div style="font-size:12px;color:var(--text-sec)">' + esc(row.description) + '</div></section>' : '') + custom +
        '<section class="detail-section"><div class="detail-section-title">Позиции</div><div style="overflow-x:auto"><table class="detail-items"><thead><tr><th>№</th><th>Наименование</th><th>Количество</th><th>Сумма</th><th>Склад</th></tr></thead><tbody>' + items + '</tbody></table></div></section>' + quotes +
        (timeline ? '<section class="detail-section"><div class="detail-section-title">Маршрут</div><div class="timeline">' + timeline + '</div></section>' : '') +
        '<div class="detail-actions">' + (actions || '<span class="request-meta">Доступных действий сейчас нет</span>') + '</div>';
    }
    function closeRequestDetail() { document.getElementById('requestDetailModal').classList.add('hidden'); currentRequest = null; }
    document.getElementById('detailClose').addEventListener('click', closeRequestDetail);
    document.getElementById('requestDetailModal').addEventListener('click', (event) => { if (event.target.id === 'requestDetailModal') closeRequestDetail(); });
    document.getElementById('detailBody').addEventListener('click', async (event) => {
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
        fields.push(actionField('actionPayment','Тип оплаты','<select class="fin" id="actionPayment"><option>Перечисление</option><option>Наличные</option></select>'));
        fields.push(actionField('actionNds','НДС','<select class="fin" id="actionNds"><option value="false">Без НДС</option><option value="true">С НДС</option></select>'));
        fields.push('<div class="modal-field full"><label>Цена за единицу по каждой позиции</label><div class="quote-item-fields">' + (currentRequest.items || []).map((item) => '<label><span>' + esc(item.name || item.itemName || 'Позиция') + ' · ' + esc(item.quantity || 0) + ' ' + esc(item.unit || item.unitName || '') + '</span><input class="fin" data-quote-item="' + esc(item.id) + '" type="number" min="0" required placeholder="Цена, UZS" /></label>').join('') + '</div></div>');
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
        const paymentType = document.getElementById('actionPayment').value;
        const ndsIncluded = document.getElementById('actionNds').value === 'true';
        body.supplierName = supplier;
        body.paymentType = paymentType;
        body.ndsIncluded = ndsIncluded;
        body.quoteItems = [...document.querySelectorAll('[data-quote-item]')].map((input) => ({itemId:input.dataset.quoteItem,unitPrice:Number(input.value),supplierName:supplier,paymentType,ndsIncluded}));
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

    /* ── shared users, dashboard accounts, roles and permissions ── */
    let people = [];
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
        const tasks = [coreApi('/admin/users')];
        if (hasPermission('roles.manage')) tasks.push(coreApi('/admin/roles'));
        const data = await Promise.all(tasks);
        people = data[0] || [];
        if (data[1]) adminRoles = data[1];
        peopleLoaded = true;
        renderPeople();
      } catch (err) {
        document.getElementById('peopleList').innerHTML = '<div class="empty-admin">' + esc(err instanceof Error ? err.message : 'Не удалось загрузить пользователей') + '</div>';
      }
    }
    function renderPeople() {
      const query = document.getElementById('peopleSearch').value.trim().toLowerCase();
      const filtered = people.filter((u) => !query || [u.fullName,u.username,u.telegramId,u.position].some((v) => String(v || '').toLowerCase().includes(query)));
      document.getElementById('usersTotal').textContent = people.length;
      document.getElementById('usersWeb').textContent = people.filter((u) => u.username).length;
      document.getElementById('usersTelegram').textContent = people.filter((u) => u.telegramId).length;
      const head = '<div class="people-row head"><span>Сотрудник</span><span>Каналы входа</span><span>Роли</span><span>Статус</span><span></span></div>';
      const body = filtered.map((u) => {
        const roles = (u.roles || []).map((r) => '<span class="role-chip">' + esc(r.roleCode || 'role') + '</span>').join('') || '<span class="identity-meta">Нет роли</span>';
        const channels = '<div class="identity-meta">' + (u.username ? '@' + esc(u.username) : 'Dashboard —') + '</div><div class="identity-meta">' + (u.telegramId ? 'TG ' + esc(u.telegramId) : 'Telegram —') + '</div>';
        const action = hasPermission('users.manage') ? '<button class="mini-action" data-edit-user="' + esc(u.id) + '">Настроить</button>' : '';
        return '<div class="people-row"><div class="identity"><span class="avatar">' + esc(initials(u.fullName)) + '</span><div style="min-width:0"><div class="identity-name">' + esc(u.fullName) + '</div><div class="identity-meta">' + esc(u.position || u.email || 'Без должности') + '</div></div></div><div>' + channels + '</div><div class="role-list">' + roles + '</div><span class="status-dot ' + (u.status === 'active' ? 'active' : '') + '">' + esc(statusLabel(u.status)) + '</span><div>' + action + '</div></div>';
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
    function openAccount(user) {
      const editing = Boolean(user);
      document.getElementById('accountId').value = user ? user.id : '';
      document.getElementById('accountTitle').textContent = editing ? 'Настроить пользователя' : 'Новый пользователь';
      document.getElementById('accountName').value = user ? user.fullName || '' : '';
      document.getElementById('accountPosition').value = user ? user.position || '' : '';
      document.getElementById('accountUsername').value = user ? user.username || '' : '';
      document.getElementById('accountPassword').value = '';
      document.getElementById('accountTelegram').value = user ? user.telegramId || '' : '';
      document.getElementById('accountEmail').value = user ? user.email || '' : '';
      document.getElementById('accountPhone').value = user ? user.phone || '' : '';
      document.getElementById('accountStatus').value = user ? user.status || 'active' : 'active';
      document.getElementById('accountStatus').closest('.modal-field').classList.toggle('hidden', !editing);
      document.getElementById('passwordHint').textContent = editing ? '(оставьте пустым без изменения)' : '';
      document.getElementById('accountSave').textContent = editing ? 'Сохранить изменения' : 'Создать пользователя';
      document.getElementById('accountErr').textContent = '';
      fillAccountRoles(user);
      document.getElementById('accountModal').classList.remove('hidden');
      document.getElementById('accountName').focus();
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
        position:document.getElementById('accountPosition').value.trim(),
        username:document.getElementById('accountUsername').value.trim(),
        telegramId:document.getElementById('accountTelegram').value.trim(),
        email:document.getElementById('accountEmail').value.trim(),
        phone:document.getElementById('accountPhone').value.trim(),
        ...(password ? {password} : {}),
        ...(id ? {status:document.getElementById('accountStatus').value} : {}),
      };
      const roleId = document.getElementById('accountRole').value;
      const save = document.getElementById('accountSave');
      const error = document.getElementById('accountErr');
      error.textContent = '';
      if (!id && !password) { error.textContent = 'Укажите пароль минимум из 8 символов'; return; }
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
      document.getElementById('rolesGrid').innerHTML = adminRoles.map((role) => {
        const perms = (role.permissions || []).slice(0,8).map((code) => '<span class="perm-chip">' + esc(code) + '</span>').join('');
        const actions = role.isSystem
          ? '<span class="role-count">Системная</span>'
          : '<div class="role-actions"><button class="mini-action" data-edit-role="' + esc(role.id) + '">Редактировать</button><button class="mini-action danger" data-delete-role="' + esc(role.id) + '">Удалить</button></div>';
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
        if (id) await coreApi('/admin/roles/' + encodeURIComponent(id), 'PUT', {name});
        else roleId = (await coreApi('/admin/roles', 'POST', {name,code})).id;
        await coreApi('/admin/roles/' + encodeURIComponent(roleId) + '/permissions', 'PUT', {codes});
        toast(id ? 'Роль обновлена' : 'Роль создана');
        closeRole();
        peopleLoaded = false;
        await ensureRoleData(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Не удалось сохранить роль';
      } finally { save.disabled = false; }
    });

    /* ── create view ── */
    const form = { type:'', origin:'local', priority:'normal', items:[] };
    function emptyItem() { return { name:'', code:'', qty:'', unit:'', price:'', pay:'Банк', note:'' }; }
    async function ensureMeta() {
      if (meta) return;
      try {
        meta = await api('meta');
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
      fillSelect('fRequester', meta.users, 'id', 'name', false);
      document.getElementById('fRequester').value = session.user.id;
      document.getElementById('fRequester').disabled = !hasPermission('users.manage');
      fillSelect('fDepartment', meta.departments, 'id', 'name', true);
      fillSelect('fObject', meta.objects, 'value', 'label', true);
      fillSelect('fWarehouse', meta.warehouses.map((w) => ({ v:w, l:w })), 'v', 'l', true);
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
      renderItems();
      syncUrgency();
      syncMaterialOnly();
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
        '<td><input data-f="name" placeholder="Например: Хлопковая пряжа 40/1" value="' + esc(it.name) + '"/></td>' +
        '<td><input data-f="code" placeholder="Код" value="' + esc(it.code) + '"/></td>' +
        '<td><input data-f="qty" type="number" min="0" placeholder="0" value="' + esc(it.qty) + '"/></td>' +
        '<td><select data-f="unit"><option value="">—</option>' + meta.units.map((u) => '<option' + (u.value === it.unit ? ' selected' : '') + '>' + esc(u.label) + '</option>').join('') + '</select></td>' +
        '<td><input data-f="price" type="number" min="0" placeholder="—" value="' + esc(it.price) + '"/></td>' +
        '<td><select data-f="pay"><option' + (it.pay === 'Банк' ? ' selected' : '') + '>Банк</option><option' + (it.pay === 'Нал.' ? ' selected' : '') + '>Нал.</option></select></td>' +
        '<td><input data-f="note" placeholder="—" value="' + esc(it.note) + '"/></td>' +
        '<td><button class="row-x" data-action="rm" type="button"' + (form.items.length <= 1 ? ' disabled' : '') + '>×</button></td>' +
        '</tr>'
      ).join('');
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
      form.items[i][cell.dataset.f] = cell.value;
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
      const btn = document.getElementById('formSubmit');
      btn.disabled = true;
      try {
        const requesterId = document.getElementById('fRequester').value;
        const dashboardPayload = {
          requesterId,
          requestType: form.type,
          departmentId: document.getElementById('fDepartment').value,
          warehouseName: form.type.indexOf('material') === 0 ? document.getElementById('fWarehouse').value : '',
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
          warehouseName:dashboardPayload.warehouseName || null,
          priority:dashboardPayload.priority,
          neededDate:dashboardPayload.neededDate || null,
          title:form.items.map((item) => item.name.trim()).filter(Boolean).slice(0,3).join(', ') || 'Новая заявка',
          description:dashboardPayload.comment || null,
          customFields:{obyekt:dashboardPayload.obyekt,origin:dashboardPayload.origin,purpose:dashboardPayload.purpose},
          items:form.items.filter((item) => item.name.trim()).map((item) => ({
            name:item.name.trim(), quantity:Number(item.qty), unitPrice:Number(item.price) || 0,
            unit:item.unit || null, description:[item.code ? 'Код товара: ' + item.code : '',item.note ? 'Примечание: ' + item.note : ''].filter(Boolean).join('\\n') || null,
          })),
        };
        // Ordinary dashboard creation uses the canonical API, so workflow,
        // notifications, audit and validation are identical to Telegram Web App.
        // The dashboard-only route remains for the explicit admin-on-behalf case.
        const out = requesterId === session.user.id
          ? await coreApi('/requests', 'POST', canonicalPayload)
          : await api('requests', dashboardPayload);
        toast('Заявка создана: ' + out.requestNumber);
        form.items = [emptyItem()];
        renderItems();
        document.getElementById('fComment').value = '';
        document.getElementById('fNeeded').value = '';
        requestsLoaded = false;
        await load();
        showView('overview');
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
        sessionStorage.setItem('snab_dashboard_token', auth.token);
        await enterApp();
      } catch (err) {
        sessionStorage.removeItem('snab_dashboard_token');
        error.textContent = err instanceof Error ? err.message : 'Ошибка входа';
        document.getElementById('password').select();
      } finally {
        submit.disabled = false;
        submit.textContent = 'Войти в систему';
      }
    });
    document.getElementById('search').addEventListener('input', (e) => syncSearch(e.target.value));
    document.getElementById('mobileSearch').addEventListener('input', (e) => syncSearch(e.target.value));
    document.getElementById('menuToggle').addEventListener('click', () => {
      const next = !document.body.classList.contains('sidebar-open');
      document.body.classList.toggle('sidebar-open', next);
      document.getElementById('menuToggle').setAttribute('aria-label', next ? 'Закрыть меню' : 'Открыть меню');
    });
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
    document.getElementById('toggleFilters').addEventListener('click', () => {
      document.getElementById('tableSettingsPanel').classList.add('hidden');
      document.getElementById('filtersPanel').classList.toggle('open');
    });
    document.getElementById('toggleTableSettings').addEventListener('click', (event) => {
      event.stopPropagation();
      renderColumnSettings();
      document.getElementById('filtersPanel').classList.remove('open');
      document.getElementById('tableSettingsPanel').classList.toggle('hidden');
    });
    document.getElementById('tableSettingsPanel').addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => document.getElementById('tableSettingsPanel').classList.add('hidden'));
    document.getElementById('columnSettings').addEventListener('change', (event) => {
      const input = event.target.closest('[data-column-key]');
      if (!input) return;
      if (input.checked) visibleColumnKeys.add(input.dataset.columnKey);
      else visibleColumnKeys.delete(input.dataset.columnKey);
      if (!visibleColumnKeys.size) {
        visibleColumnKeys.add('requestNumber');
        input.checked = true;
        toast('Нужен хотя бы один столбец');
      }
      saveVisibleColumns();
      renderColumnSettings();
      render();
    });
    document.getElementById('showDefaultColumns').addEventListener('click', () => setVisibleColumns([...defaultVisibleKeys]));
    document.getElementById('showAllColumns').addEventListener('click', () => setVisibleColumns(keys));
    document.getElementById('clearFilters').addEventListener('click', () => {
      for (const select of document.querySelectorAll('select[data-filter-key]')) for (const option of select.options) option.selected = false;
      for (const select of document.querySelectorAll('[data-filter-mode]')) select.value = 'in';
      document.getElementById('search').value = '';
      document.getElementById('mobileSearch').value = '';
      resetPageAndRender();
    });
    document.getElementById('pageSize').addEventListener('change', (event) => {
      tableState.pageSize = Number(event.target.value) || 25;
      resetPageAndRender();
    });
    document.getElementById('firstPage').addEventListener('click', () => { tableState.page = 1; render(); });
    document.getElementById('prevPage').addEventListener('click', () => { tableState.page = Math.max(1, tableState.page - 1); render(); });
    document.getElementById('nextPage').addEventListener('click', () => { tableState.page += 1; render(); });
    document.getElementById('lastPage').addEventListener('click', () => {
      const total = rows.filter((r) => {
        const q = activeSearch();
        const fv = filterValues();
        if (q && !JSON.stringify(r).toLowerCase().includes(q)) return false;
        for (const [key, filter] of Object.entries(fv)) if (!rowMatchesFilter(r, key, filter)) return false;
        return true;
      }).length;
      tableState.page = Math.max(1, Math.ceil(total / tableState.pageSize));
      render();
    });
    document.getElementById('togglePassword').addEventListener('click', () => {
      const input = document.getElementById('password');
      const next = input.type === 'password' ? 'text' : 'password';
      input.type = next;
      document.getElementById('togglePassword').setAttribute('aria-label', next === 'password' ? 'Показать пароль' : 'Скрыть пароль');
    });
    document.getElementById('table').addEventListener('click', async (e) => {
      const sort = e.target.closest('[data-sort-key]');
      if (sort) {
        const key = sort.dataset.sortKey;
        if (tableState.sortKey === key) tableState.sortDir = tableState.sortDir === 'asc' ? 'desc' : 'asc';
        else { tableState.sortKey = key; tableState.sortDir = numericKeys.has(key) ? 'desc' : 'asc'; }
        resetPageAndRender();
        return;
      }
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
      sessionStorage.removeItem('snab_dashboard_token');
      location.reload();
    });
    if (token()) {
      enterApp()
        .catch(() => {
          sessionStorage.removeItem('snab_dashboard_token');
        });
    }
  </script>
</body>
</html>`;
}

export function buildSnabDashboardRouter(db: Db, sessionSecret: string): Router {
  const r = Router();

  r.get('/', (_req: Request, res: Response) => {
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
    });
  });

  r.post('/api/me', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret);
    if (!actor) return;
    res.json({
      user: { id: actor.id, fullName: actor.fullName, username: actor.username, holdingId: actor.holdingId },
      permissions: actor.permissions,
    });
  });

  r.post('/api/data', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.view', 'requests.view_own']);
    if (!actor) return;
    const rows = await fetchDashboardRows(db, actor.holdingId, {
      requesterId: actor.id,
      viewAll: actor.permissions.includes('requests.view'),
    });
    res.json({ rows });
  });

  r.post('/api/meta', async (req: Request, res: Response) => {
    const actor = await requireDashboardActor(db, req, res, sessionSecret, ['requests.create']);
    if (!actor) return;
    res.json(await fetchCreateMeta(db, actor.holdingId));
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
      await updateDashboardRow(db, actor.holdingId, String(req.params.itemId), (req.body as { row?: unknown } | undefined)?.row);
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
