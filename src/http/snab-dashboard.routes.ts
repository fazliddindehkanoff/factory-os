import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';

type Db = any;

interface DashboardRow {
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

async function fetchDashboardRows(db: Db): Promise<DashboardRow[]> {
  const result = await db.execute(sql`
    SELECT
      r.created_at,
      r.request_number,
      r.warehouse_name,
      r.custom_fields,
      requester.full_name AS requester_name,
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
      contractNumber: '',
      contractDate: '',
      supplier: text(r.item_supplier_name || r.quote_supplier_name),
      person: '',
      contacts: '',
      cfoReceiver: text(r.requester_name),
      productNote: text(desc['примечание'] || r.quote_lead_time),
    };
  });
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Snabbase Dashboard</title>
  <style>
    :root { --bg:#f4f6f9; --card:#fff; --fg:#17182b; --muted:#687386; --line:#dfe5ee; --head:#1a2b4a; --accent:#2d7dd2; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
    .wrap { max-width:1440px; margin:0 auto; padding:22px; }
    .top { display:flex; justify-content:space-between; align-items:flex-end; gap:18px; margin-bottom:18px; }
    h1 { margin:0; font-size:28px; letter-spacing:0; }
    .sub { color:var(--muted); margin-top:5px; font-size:14px; }
    .login { min-height:100vh; display:grid; place-items:center; padding:20px; }
    .login-card { width:min(430px,100%); background:var(--card); border:1px solid var(--line); border-radius:16px; padding:24px; box-shadow:0 14px 40px -28px #0b1b38; }
    input, button { font:inherit; }
    .password { width:100%; border:1px solid var(--line); border-radius:12px; padding:13px 14px; margin:16px 0 12px; }
    .btn { border:0; border-radius:12px; padding:12px 16px; background:var(--accent); color:white; font-weight:800; cursor:pointer; }
    .btn.secondary { background:white; color:var(--fg); border:1px solid var(--line); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; }
    .search { min-width:300px; border:1px solid var(--line); border-radius:12px; padding:11px 13px; background:white; }
    .cards { display:grid; grid-template-columns:repeat(4, minmax(150px, 1fr)); gap:12px; margin-bottom:14px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }
    .k { color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
    .v { font-size:24px; font-weight:900; margin-top:7px; }
    .table-shell { background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; }
    .scroll { overflow:auto; max-height:calc(100vh - 240px); }
    table { border-collapse:separate; border-spacing:0; min-width:2600px; width:100%; font-size:12.5px; }
    th, td { border-right:1px solid var(--line); border-bottom:1px solid var(--line); padding:9px 10px; white-space:nowrap; text-align:left; }
    th { position:sticky; top:34px; z-index:2; background:#eef3fb; font-weight:900; color:#18233a; }
    th.group { top:0; background:var(--head); color:white; text-align:center; font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
    tr:nth-child(even) td { background:#fbfcfe; }
    .num { text-align:right; font-variant-numeric:tabular-nums; font-family:"SFMono-Regular", Consolas, monospace; }
    .err { color:#b42318; font-size:13px; min-height:18px; }
    .hidden { display:none; }
    @media (max-width:760px) {
      .wrap { padding:14px; }
      .top { align-items:stretch; flex-direction:column; }
      .cards { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .search { min-width:0; width:100%; }
      .scroll { max-height:calc(100vh - 300px); }
    }
  </style>
</head>
<body>
  <main id="login" class="login">
    <form class="login-card" id="loginForm">
      <h1>Snabbase</h1>
      <div class="sub">Закрытый dashboard по форме Excel</div>
      <input class="password" id="password" type="password" placeholder="Пароль" autocomplete="current-password" />
      <div class="err" id="loginErr"></div>
      <button class="btn" type="submit">Войти</button>
    </form>
  </main>
  <main id="app" class="wrap hidden">
    <div class="top">
      <div>
        <h1>Snabbase Dashboard</h1>
        <div class="sub" id="updated"></div>
      </div>
      <div class="toolbar">
        <input id="search" class="search" placeholder="Поиск по объекту, заявке, товару, поставщику..." />
        <button id="logout" class="btn secondary">Выйти</button>
      </div>
    </div>
    <section class="cards">
      <div class="card"><div class="k">Строк</div><div class="v" id="kRows">0</div></div>
      <div class="card"><div class="k">Заявок</div><div class="v" id="kRequests">0</div></div>
      <div class="card"><div class="k">Сумма</div><div class="v" id="kAmount">0</div></div>
      <div class="card"><div class="k">Поставщиков</div><div class="v" id="kSuppliers">0</div></div>
    </section>
    <section class="table-shell">
      <div class="scroll"><table id="table"></table></div>
    </section>
  </main>
  <script>
    const headers = ${JSON.stringify(HEADERS)};
    const groups = ${JSON.stringify(GROUPS)};
    const keys = ${JSON.stringify(KEYS)};
    let rows = [];
    const fmt = new Intl.NumberFormat('ru-RU');
    const money = (v) => fmt.format(Math.round(Number(v) || 0));
    const numericKeys = new Set(['quantity','unitPrice','exchangeRate','amount','usdAmount','ndsRate','amountWithNds','usdAmountWithNds']);
    function pass() { return sessionStorage.getItem('snab_dashboard_password') || ''; }
    async function load() {
      const res = await fetch('/snab-dashboard/api/data', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ password: pass() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Ошибка загрузки');
      rows = body.rows || [];
      document.getElementById('updated').textContent = 'Обновлено: ' + new Date().toLocaleString('ru-RU');
      render();
    }
    function render() {
      const q = document.getElementById('search').value.trim().toLowerCase();
      const data = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
      document.getElementById('kRows').textContent = fmt.format(data.length);
      document.getElementById('kRequests').textContent = fmt.format(new Set(data.map((r) => r.requestNumber).filter(Boolean)).size);
      document.getElementById('kAmount').textContent = money(data.reduce((sum, r) => sum + Number(r.amount || 0), 0));
      document.getElementById('kSuppliers').textContent = fmt.format(new Set(data.map((r) => r.supplier).filter(Boolean)).size);
      const table = document.getElementById('table');
      table.innerHTML =
        '<thead><tr>' + groups.map((g) => '<th class="group" colspan="' + g[1] + '">' + escapeHtml(g[0]) + '</th>').join('') + '</tr><tr>' +
        headers.map((h) => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' +
        data.map((r) => '<tr>' + keys.map((k) => '<td class="' + (numericKeys.has(k) ? 'num' : '') + '">' + (numericKeys.has(k) ? money(r[k]) : escapeHtml(r[k] ?? '')) + '</td>').join('') + '</tr>').join('') +
        '</tbody>';
    }
    function escapeHtml(v) {
      return String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }
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
    document.getElementById('search').addEventListener('input', render);
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

  r.post('/api/data', async (req: Request, res: Response) => {
    if (!dashboardPassword()) {
      res.status(503).json({ error: 'Dashboard password is not configured' });
      return;
    }
    if (!isAuthorized((req.body as { password?: unknown } | undefined)?.password)) {
      res.status(401).json({ error: 'Неверный пароль' });
      return;
    }
    const rows = await fetchDashboardRows(db);
    res.json({ rows });
  });

  return r;
}
