import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { createRequest } from '../services/request.service.js';

type Db = any;

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
  'Mесяц',
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
  'Поставшик',
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

function dashboardPassword(): string {
  return process.env.SNAB_DASHBOARD_PASSWORD ?? '';
}

function isAuthorized(raw: unknown): boolean {
  const expected = dashboardPassword();
  if (!expected || typeof raw !== 'string') return false;
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

async function fetchDashboardRows(db: Db): Promise<DashboardRow[]> {
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

async function updateDashboardRow(db: Db, itemId: string, patch: unknown): Promise<void> {
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

async function deleteDashboardRow(db: Db, itemId: string): Promise<void> {
  const result = await db.execute(sql`
    DELETE FROM request_items
    WHERE id = ${itemId}
    RETURNING request_id
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  const requestId = text(rows[0]?.request_id);
  if (!requestId) throw new Error('Dashboard row not found');
  await refreshRequestAmount(db, requestId);
}

// ── Meta + create (the «Новая заявка» view of the dashboard) ─────────────────

/** The dashboard is per-deployment (password-gated, not user-scoped): resolve
 *  the primary holding as «the one with the most requests», fallback first. */
async function primaryHoldingId(db: Db): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT h.id
    FROM holdings h
    LEFT JOIN requests r ON r.holding_id = h.id
    GROUP BY h.id, h.created_at
    ORDER BY COUNT(r.id) DESC, h.created_at ASC
    LIMIT 1
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result) ? result : (result.rows ?? []);
  return rows[0] ? text(rows[0].id) : null;
}

function optionList(v: unknown): { value: string; label: string }[] {
  const raw = Array.isArray(v) ? v : [];
  return raw
    .map((o) => ({ value: text((o as any)?.value), label: text((o as any)?.label) || text((o as any)?.value) }))
    .filter((o) => o.value);
}

async function fetchCreateMeta(db: Db): Promise<Record<string, unknown>> {
  const holdingId = await primaryHoldingId(db);
  if (!holdingId) return { holdingId: null, users: [], departments: [], warehouses: [], types: [], objects: [], purposes: [], origins: [], units: [], priorities: [] };

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

async function createFromDashboard(db: Db, body: CreateBody): Promise<{ id: string; requestNumber: string }> {
  const holdingId = await primaryHoldingId(db);
  if (!holdingId) throw new Error('Нет холдинга');
  const requesterId = text(body.requesterId).trim();
  if (!requesterId) throw new Error('Укажите заявителя');

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
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
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
    *{box-sizing:border-box;}
    body{margin:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;color-scheme:dark;}
    input,select,textarea,button{font:inherit;color:inherit;}
    .app-shell{min-height:100vh;display:grid;grid-template-columns:264px minmax(0,1fr);}
    /* ── login ── */
    .login{min-height:100vh;display:grid;place-items:center;padding:20px;}
    .login-card{width:min(420px,100%);background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px;}
    .login-card h1{margin:0;font-size:22px;}
    .login-card .sub{color:var(--text-sec);margin-top:5px;font-size:13px;}
    .password-wrap{position:relative;margin:18px 0 12px;}
    .password{width:100%;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-ctl);padding:12px 48px 12px 13px;outline:none;}
    .password:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    .eye{position:absolute;right:7px;top:7px;width:34px;height:34px;border:0;border-radius:9px;background:rgba(255,255,255,0.06);color:var(--text-sec);display:grid;place-items:center;cursor:pointer;}
    .btn{border:0;border-radius:11px;padding:11px 17px;background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#fff;font-weight:600;font-size:13.5px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;transition:filter .12s;}
    .btn:hover{filter:brightness(1.1);}
    .btn.secondary{background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);}
    .btn.secondary:hover{background:rgba(255,255,255,0.09);}
    .btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text-sec);}
    .btn.ghost:hover{background:var(--card-hover);color:var(--text);}
    /* ── sidebar: navigation only ── */
    .sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:var(--bg-elev);border-right:1px solid var(--border);padding:20px 14px 16px;display:flex;flex-direction:column;}
    .side-brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px;letter-spacing:.03em;padding:2px 8px 18px;}
    .brand-dot{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--accent1),var(--accent2));flex:none;}
    .side-caption{color:var(--text-muted);font-size:11px;font-weight:500;margin-top:1px;}
    .side-cta{width:100%;margin-bottom:6px;}
    .nav-sec{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);padding:16px 10px 6px;}
    .side-link{display:flex;align-items:center;gap:11px;width:100%;padding:9px 10px;border:none;border-radius:10px;background:none;color:var(--text-sec);font-size:13.5px;font-weight:500;cursor:pointer;text-align:left;transition:background .12s,color .12s;}
    .side-link:hover{background:rgba(255,255,255,0.05);color:var(--text);}
    .side-link.active{background:rgba(99,102,241,0.15);color:#A5B4FC;font-weight:600;}
    .side-link svg{flex:0 0 auto;}
    .side-bottom{margin-top:auto;border-top:1px solid var(--border);padding-top:12px;}
    /* ── main ── */
    .main-pane{min-width:0;display:flex;flex-direction:column;}
    .navbar{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:14px;min-height:64px;padding:12px 24px;background:rgba(8,13,25,0.92);border-bottom:1px solid var(--border);backdrop-filter:blur(8px);}
    .nav-left{display:flex;align-items:center;gap:12px;min-width:0;}
    .menu-btn{display:none;width:42px;height:42px;border:1px solid var(--border);border-radius:11px;background:transparent;color:var(--text-sec);cursor:pointer;}
    .brand-title{font-size:15px;font-weight:600;line-height:1.15;}
    .brand-sub{color:var(--text-muted);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw;}
    .nav-actions{display:flex;align-items:center;gap:10px;min-width:0;}
    .search{width:min(400px,32vw);background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:11px;padding:10px 13px;outline:none;}
    .search::placeholder{color:var(--text-muted);}
    .search:focus{border-color:var(--accent1);box-shadow:0 0 0 3px rgba(99,102,241,0.15);}
    .wrap{min-width:0;padding:22px 24px 60px;}
    .top{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:0 0 18px;}
    h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em;}
    .sub{color:var(--text-sec);margin-top:5px;font-size:13px;}
    /* KPI */
    .cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin-bottom:16px;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:14px 16px;}
    .k{color:var(--text-sec);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;}
    .v{font-size:24px;font-weight:600;margin-top:7px;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    /* toolbar + collapsible filters (moved OUT of the sidebar) */
    .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
    .filter-count{min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:var(--accent1);color:#fff;font-size:10.5px;font-weight:700;line-height:19px;text-align:center;display:none;}
    .filters-panel{display:none;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);padding:14px;margin-bottom:14px;}
    .filters-panel.open{display:block;}
    .filters-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;}
    .filter-field label{display:block;margin-bottom:4px;color:var(--text-muted);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}
    .filter-field input{width:100%;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:9px;padding:8px 10px;font-size:12.5px;outline:none;}
    .filter-field input:focus{border-color:var(--accent1);}
    /* table */
    .table-shell{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;}
    .scroll{overflow:auto;max-height:calc(100vh - 320px);}
    table{border-collapse:separate;border-spacing:0;min-width:2750px;width:100%;font-size:12.5px;}
    th,td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:9px 10px;white-space:nowrap;text-align:left;}
    th{position:sticky;top:33px;z-index:2;background:#111a30;font-weight:600;color:var(--text-sec);font-size:11.5px;}
    th.group{top:0;background:#0A0F1D;color:#A5B4FC;text-align:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;}
    tr:nth-child(even) td{background:rgba(255,255,255,0.015);}
    .num{text-align:right;font-variant-numeric:tabular-nums;font-family:'IBM Plex Mono',ui-monospace,monospace;}
    .editable{min-width:70px;outline:0;box-shadow:inset 0 0 0 1px transparent;}
    .editable:focus{background:rgba(99,102,241,0.12);box-shadow:inset 0 0 0 2px var(--accent1);}
    .actions{display:flex;gap:6px;}
    .mini{border:1px solid var(--border);border-radius:9px;padding:6px 9px;background:transparent;color:var(--text-sec);font-weight:600;font-size:12px;cursor:pointer;}
    .mini:hover{background:var(--card-hover);}
    .mini.save{color:var(--green);}
    .mini.delete{color:var(--red);}
    .dirty td{background:rgba(245,158,11,0.08) !important;}
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
      .app-shell{display:block;}
      .wrap{padding:14px 14px 40px;}
      .navbar{padding:10px 14px;}
      .menu-btn{display:grid;place-items:center;}
      .nav-actions .search{display:none;}
      .top{align-items:stretch;flex-direction:column;}
      .cards{grid-template-columns:repeat(2,minmax(0,1fr));}
      .sidebar{position:fixed;inset:0 auto 0 0;z-index:30;width:min(300px,calc(100vw - 42px));height:100dvh;transform:translateX(-105%);transition:transform .2s ease;}
      body.sidebar-open .sidebar{transform:translateX(0);}
      .field-row{grid-template-columns:1fr;}
      .scroll{max-height:calc(100vh - 340px);}
    }
    @media (min-width:761px){ .mobile-search{display:none;} }
  </style>
</head>
<body>
  <main id="login" class="login">
    <form class="login-card" id="loginForm">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><span class="brand-dot"></span><h1>Снабжение</h1></div>
      <div class="sub">Закрытый dashboard отдела снабжения</div>
      <div class="password-wrap">
        <input class="password" id="password" type="password" placeholder="Пароль" autocomplete="current-password" />
        <button class="eye" id="togglePassword" type="button" aria-label="Показать пароль">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>
        </button>
      </div>
      <div class="err" id="loginErr"></div>
      <button class="btn" type="submit" style="width:100%;">Войти</button>
    </form>
  </main>
  <main id="app" class="hidden">
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="side-brand"><span class="brand-dot"></span>
          <div>FACTORY OS<div class="side-caption">Снабжение</div></div>
        </div>
        <button class="btn side-cta" id="ctaNew" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          Новая заявка
        </button>
        <div class="nav-sec">Меню</div>
        <button class="side-link active" data-view="overview" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 13h6V4H4v9Zm10 7h6V4h-6v16ZM4 20h6v-5H4v5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          Обзор
        </button>
        <button class="side-link" data-view="create" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          Новая заявка
        </button>
        <div class="side-bottom">
          <button class="side-link" id="logout" type="button">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 12H4m0 0 3.5-3.5M4 12l3.5 3.5M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Выйти
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
              <div class="brand-title" id="navTitle">Обзор закупок</div>
              <div class="brand-sub" id="updated"></div>
            </div>
          </div>
          <div class="nav-actions" id="overviewActions">
            <input id="search" class="search" placeholder="Поиск по объекту, заявке, товару, поставщику..." />
          </div>
        </header>

        <!-- ── VIEW: overview (KPI + filters + table) ── -->
        <div class="wrap" id="viewOverview">
          <div class="top">
            <div>
              <h1>Обзор закупок</h1>
              <div class="sub">Excel-структура закупок: редактирование строк и фильтры</div>
            </div>
            <input id="mobileSearch" class="search mobile-search" placeholder="Поиск..." />
          </div>
          <section class="cards">
            <div class="card"><div class="k">Строк</div><div class="v" id="kRows">0</div></div>
            <div class="card"><div class="k">Заявок</div><div class="v" id="kRequests">0</div></div>
            <div class="card"><div class="k">Сумма</div><div class="v" id="kAmount">0</div></div>
            <div class="card"><div class="k">Поставщиков</div><div class="v" id="kSuppliers">0</div></div>
          </section>
          <div class="toolbar">
            <button class="btn ghost" id="toggleFilters" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              Фильтры <span class="filter-count" id="filterCount">0</span>
            </button>
            <button class="btn ghost" id="clearFilters" type="button">Очистить</button>
          </div>
          <section class="filters-panel" id="filtersPanel" aria-label="Фильтры таблицы">
            <div id="filters" class="filters-grid"></div>
          </section>
          <section class="table-shell">
            <div class="scroll"><table id="table"></table></div>
          </section>
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
  </main>
  <script>
    const headers = ${JSON.stringify(HEADERS)};
    const groups = ${JSON.stringify(GROUPS)};
    const keys = ${JSON.stringify(KEYS)};
    const editableKeys = new Set(${JSON.stringify([...EDITABLE_KEYS])});
    let rows = [];
    let filtersReady = false;
    let meta = null;
    const fmt = new Intl.NumberFormat('ru-RU');
    const money = (v) => fmt.format(Math.round(Number(v) || 0));
    const numericKeys = new Set(['quantity','unitPrice','exchangeRate','amount','usdAmount','ndsRate','amountWithNds','usdAmountWithNds']);
    let pendingDeleteRow = null;
    function pass() { return sessionStorage.getItem('snab_dashboard_password') || ''; }
    function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    async function api(path, body) {
      const res = await fetch('/snab-dashboard/api/' + path, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(Object.assign({ password: pass() }, body || {})),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Ошибка запроса');
      return out;
    }

    /* ── view switching (sidebar = navigation) ── */
    function showView(view) {
      const overview = view === 'overview';
      document.getElementById('viewOverview').classList.toggle('hidden', !overview);
      document.getElementById('viewCreate').classList.toggle('hidden', overview);
      document.getElementById('overviewActions').style.visibility = overview ? 'visible' : 'hidden';
      document.getElementById('navTitle').textContent = overview ? 'Обзор закупок' : 'Новая заявка';
      for (const link of document.querySelectorAll('.side-link[data-view]')) {
        link.classList.toggle('active', link.dataset.view === view);
      }
      if (!overview) ensureMeta();
      closeSidebar();
    }
    document.querySelectorAll('.side-link[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    document.getElementById('ctaNew').addEventListener('click', () => showView('create'));
    document.getElementById('formCancel').addEventListener('click', () => showView('overview'));

    /* ── overview: search / filters / table ── */
    function activeSearch() {
      const desktop = document.getElementById('search').value.trim();
      const mobile = document.getElementById('mobileSearch').value.trim();
      return (desktop || mobile).toLowerCase();
    }
    function syncSearch(value) {
      document.getElementById('search').value = value;
      document.getElementById('mobileSearch').value = value;
      render();
    }
    function closeSidebar() {
      document.body.classList.remove('sidebar-open');
      document.getElementById('menuToggle').setAttribute('aria-label', 'Открыть меню');
    }
    function filterValues() {
      const out = {};
      for (const input of document.querySelectorAll('[data-filter-key]')) {
        const v = input.value.trim().toLowerCase();
        if (v) out[input.dataset.filterKey] = v;
      }
      return out;
    }
    function renderFilters() {
      if (filtersReady) return;
      const box = document.getElementById('filters');
      box.innerHTML = keys.map((key, i) =>
        '<div class="filter-field"><label>' + esc(headers[i]) + '</label><input data-filter-key="' + key + '" placeholder="Фильтр..." /></div>'
      ).join('');
      box.addEventListener('input', render);
      filtersReady = true;
    }
    function rowValue(r, key) { return String(r[key] ?? '').toLowerCase(); }
    function toast(message) {
      const el = document.getElementById('toast');
      el.textContent = message;
      el.classList.remove('hidden');
      clearTimeout(window.__snabToast);
      window.__snabToast = setTimeout(() => el.classList.add('hidden'), 3000);
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
        for (const [key, value] of Object.entries(fv)) {
          if (!rowValue(r, key).includes(value)) return false;
        }
        return true;
      });
      document.getElementById('kRows').textContent = fmt.format(data.length);
      document.getElementById('kRequests').textContent = fmt.format(new Set(data.map((r) => r.requestNumber).filter(Boolean)).size);
      document.getElementById('kAmount').textContent = money(data.reduce((sum, r) => sum + Number(r.amount || 0), 0));
      document.getElementById('kSuppliers').textContent = fmt.format(new Set(data.map((r) => r.supplier).filter(Boolean)).size);
      const table = document.getElementById('table');
      table.innerHTML =
        '<thead><tr>' + groups.map((g) => '<th class="group" colspan="' + g[1] + '">' + esc(g[0]) + '</th>').join('') + '<th class="group" colspan="1"></th></tr><tr>' +
        headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '<th>Действия</th></tr></thead><tbody>' +
        data.map((r) => '<tr data-item-id="' + esc(r.itemId) + '">' + keys.map((k) => cellHtml(r, k)).join('') + actionsHtml(r) + '</tr>').join('') +
        '</tbody>';
    }
    function cellHtml(r, k) {
      const value = numericKeys.has(k) ? String(Math.round(Number(r[k]) || 0)) : String(r[k] ?? '');
      const cls = (numericKeys.has(k) ? 'num ' : '') + (editableKeys.has(k) ? 'editable' : '');
      const editable = editableKeys.has(k) ? ' contenteditable="true" data-key="' + k + '"' : '';
      return '<td class="' + cls + '"' + editable + '>' + esc(numericKeys.has(k) ? money(value) : value) + '</td>';
    }
    function actionsHtml() {
      return '<td><div class="actions"><button class="mini save" data-action="save">Save</button><button class="mini delete" data-action="delete">Delete</button></div></td>';
    }
    function rowPayload(tr) {
      const out = {};
      for (const td of tr.querySelectorAll('[data-key]')) {
        const key = td.dataset.key;
        const raw = td.textContent.trim();
        out[key] = numericKeys.has(key) ? Number(raw.replace(/\\s/g, '').replace(',', '.')) || 0 : raw;
      }
      return out;
    }
    async function saveRow(tr) {
      const res = await fetch('/snab-dashboard/api/row/' + encodeURIComponent(tr.dataset.itemId), {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ password: pass(), row: rowPayload(tr) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Не удалось сохранить');
      await load();
      toast('Сохранено');
    }
    async function deleteRow(tr) {
      const res = await fetch('/snab-dashboard/api/row/' + encodeURIComponent(tr.dataset.itemId), {
        method:'DELETE', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ password: pass() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Не удалось удалить');
      await load();
      toast('Удалено');
    }

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
        const out = await api('requests', {
          requesterId: document.getElementById('fRequester').value,
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
        });
        toast('Заявка создана: ' + out.requestNumber);
        form.items = [emptyItem()];
        renderItems();
        document.getElementById('fComment').value = '';
        document.getElementById('fNeeded').value = '';
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
      document.getElementById('loginErr').textContent = '';
      sessionStorage.setItem('snab_dashboard_password', document.getElementById('password').value);
      try {
        await load();
        document.getElementById('login').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
      } catch (err) {
        sessionStorage.removeItem('snab_dashboard_password');
        document.getElementById('loginErr').textContent = err instanceof Error ? err.message : 'Ошибка входа';
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
      document.getElementById('filtersPanel').classList.toggle('open');
    });
    document.getElementById('clearFilters').addEventListener('click', () => {
      for (const input of document.querySelectorAll('[data-filter-key]')) input.value = '';
      document.getElementById('search').value = '';
      document.getElementById('mobileSearch').value = '';
      render();
    });
    document.getElementById('togglePassword').addEventListener('click', () => {
      const input = document.getElementById('password');
      const next = input.type === 'password' ? 'text' : 'password';
      input.type = next;
      document.getElementById('togglePassword').setAttribute('aria-label', next === 'password' ? 'Показать пароль' : 'Скрыть пароль');
    });
    document.getElementById('table').addEventListener('input', (e) => {
      const td = e.target.closest('[data-key]');
      if (td) td.closest('tr')?.classList.add('dirty');
    });
    document.getElementById('table').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      btn.disabled = true;
      try {
        if (btn.dataset.action === 'save') await saveRow(tr);
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
      sessionStorage.removeItem('snab_dashboard_password');
      location.reload();
    });
    if (pass()) {
      load()
        .then(() => {
          document.getElementById('login').classList.add('hidden');
          document.getElementById('app').classList.remove('hidden');
        })
        .catch(() => sessionStorage.removeItem('snab_dashboard_password'));
    }
  </script>
</body>
</html>`;
}

export function buildSnabDashboardRouter(db: Db): Router {
  const r = Router();

  r.get('/', (_req: Request, res: Response) => {
    res.type('html').send(pageHtml());
  });

  const guard = (req: Request, res: Response): boolean => {
    if (!dashboardPassword()) {
      res.status(503).json({ error: 'Dashboard password is not configured' });
      return false;
    }
    if (!isAuthorized((req.body as { password?: unknown } | undefined)?.password)) {
      res.status(401).json({ error: 'Неверный пароль' });
      return false;
    }
    return true;
  };

  r.post('/api/data', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const rows = await fetchDashboardRows(db);
    res.json({ rows });
  });

  r.post('/api/meta', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    res.json(await fetchCreateMeta(db));
  });

  r.post('/api/requests', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const out = await createFromDashboard(db, req.body as CreateBody);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message || 'Не удалось создать заявку' });
    }
  });

  r.put('/api/row/:itemId', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      await updateDashboardRow(db, String(req.params.itemId), (req.body as { row?: unknown } | undefined)?.row);
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message || 'Dashboard row not found' });
    }
  });

  r.delete('/api/row/:itemId', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      await deleteDashboardRow(db, String(req.params.itemId));
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message || 'Dashboard row not found' });
    }
  });

  return r;
}
