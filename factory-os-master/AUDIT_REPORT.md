# Factory OS — Security & Logic Audit / Bug Report

> Полный отчёт по аудиту бэкенда. Предназначен для передачи ИИ-исполнителю, который должен **исправить** перечисленные дефекты. Каждая critical/high находка подтверждена реальным curl на запущенном сервере.

---

## 0. Контекст для исполнителя (прочитай прежде чем чинить)

**Что это.** Factory OS — Telegram Mini App для снабжения/согласования на заводе (заявки → цепочка согласований по суммам → склад/закупки/финансы). Бэкенд: TypeScript + Express 5 + Postgres (Neon) через Drizzle ORM, мультитенант, RBAC, data-driven workflow.

**Архитектура, критичная для понимания багов.** Фронтенд — это **сгенерированный, замороженный дизайн** в `public/` (`index.html`, `support.js`, `admin.html`), написанный под СТАРЫЙ контракт API. Бэкенд подгоняется под него через **«слой совместимости»** — `src/http/compat.routes.ts` + `src/http/legacy-auth.ts`. Это главная зона дефектов.

**ЖЁСТКИЕ ПРАВИЛА ПРАВКИ:**
1. **`public/` НЕ ТРОГАТЬ.** Дизайн заморожен. Все исправления — только в бэкенде (`src/`), чтобы ответы API совпадали с тем, что дизайн читает.
2. **Деньги — целые** (`bigint`, минорные единицы). Никаких float.
3. **Многошаговые мутации — в транзакции** (`db.transaction`).
4. **Склад — только через движения** (`stock_movements`), не править баланс «молча».
5. После правок: `npm run typecheck` (чисто) и `npm test` (зелёное).

**Где что:**
- Слой совместимости: `src/http/compat.routes.ts` (1031 стр.), `src/http/legacy-auth.ts`.
- Сервисы: `src/services/{request,approval,warehouse,dashboard}.service.ts`.
- Движок: `src/workflow/engine.ts`. RBAC: `src/rbac/{rbac,permissions,system-roles}.ts`.
- Аутентификация: `src/auth/{pin,session,telegram}.ts`. Схема: `src/db/schema.ts`. Бутстрап тенанта: `src/db/tenant-setup.ts`.
- Контракт фронта: `public/index.html` (ищи `_api(` — какие эндпоинты и поля дёргает дизайн).

**Как запускать/тестировать вживую:**
```bash
PORT=3100 ENABLE_DEV_AUTH=1 NODE_ENV=development npx tsx src/server/index.ts   # http://localhost:3100
```
Авторизация в curl: заголовок `-H "X-Dev-User-Id: demo_<role>"`, role ∈ {requester, dept_head, warehouse, procurement, finance, director, owner, admin} — засеянные демо-юзеры. Тела JSON: `-H "Content-Type: application/json"`.
**Внимание (Windows):** curl ломает кириллицу в инлайн-аргументах → в тестах используй ASCII-данные или `--data-binary @file`. «Порча кириллицы» — НЕ баг.

---

## 1. Сводная таблица (по серьёзности)

| ID | Серьёзность | Заголовок | Файл:строка |
|----|-------------|-----------|-------------|
| **BUG-01** | 🔴 critical | Отключённый юзер (`status=disabled`) сохраняет полный доступ к API | `src/http/legacy-auth.ts:30-81` |
| **BUG-02** | 🔴 critical | `receive-close` закрывает ЛЮБУЮ заявку мимо всей цепочки согласований | `src/http/compat.routes.ts:731-764` |
| **BUG-03** | 🟠 high | RBAC гейтит по имени роли, каталог прав мёртв → `director` получает всю админку | `src/http/compat.routes.ts:783-799, 821-1028` |
| **BUG-04** | 🟠 high | КП: любой `procurement` переписывает `total_amount` чужой заявки (смена тира согласования) | `src/http/compat.routes.ts:506-564` |
| **BUG-05** | 🟠 high | IDOR-запись вложений: нет доступа на чтение (403), но запись проходит (200) | `src/http/compat.routes.ts:585-622` |
| **BUG-06** | 🟡 medium | `/approvals` не отдаёт `items[]` → блок «Позиции заявки» не рендерится у согласующих | `src/http/compat.routes.ts:317-335` |
| **BUG-07** | 🟡 medium | `/approvals` всегда `department:""` и `warehouse:""` (данные есть, но не прокинуты) | `src/http/compat.routes.ts:326,333` |
| **BUG-08** | 🟡 medium | Админ-пороги `amount_threshold_*` отсутствуют в ответе И игнорируются движком | `src/http/compat.routes.ts:939-971` + `src/db/tenant-setup.ts:23-30` |
| **BUG-09** | 🟡 medium | `override` (учредитель) не проверяет холдинг/доступ к заявке (межтенантный обход) | `src/http/compat.routes.ts:417-421` |
| **BUG-10** | 🟡 medium | `/approvals` `needed_by` — сырой ISO-таймстамп вместо `YYYY-MM-DD` | `src/http/compat.routes.ts:330` |
| **BUG-11** | ⚪ low | `/dashboard` `activity[].time:""` — колонка времени всегда пустая | `src/http/compat.routes.ts:108-114` |
| **BUG-12** | ⚪ low (латентн.) | `activeWorkflow()`/`selectWorkflow()` без `ORDER BY`/гарантии единственного активного workflow | `src/http/compat.routes.ts:813-819` + `src/services/request.service.ts:61-72` |

> ❌ **Ложное срабатывание (НЕ чинить):** `POST /requests` с пустым `needed_by` → 500. Не воспроизводится. См. §4.

---

## 2. Детали — critical / high

### 🔴 BUG-01 — Отключённый/архивный пользователь не теряет доступ
**Файл:** `src/http/legacy-auth.ts:30-81` (все три ветки: Bearer `:33-42`, initData `:44-64`, dev `:66-75`).
**Экран дизайна:** Админка → Пользователи → кнопка «деактивировать/удалить» (`DELETE /api/admin/users/:id`) фактически бесполезна на боевом API.
**Что не так:** `legacyAuth` грузит `req.dbUser` по факту существования записи (`if (u)`), **не проверяя `u.status`** — в отличие от `src/http/auth.middleware.ts:31`, которое корректно отклоняет `disabled`/`archived`. Уволенный сотрудник продолжает читать и **писать** (создавать заявки, согласовывать и т.д.).
**Ожидание:** после деактивации (`status='disabled'`) запрос → `401`.
**Реальность:** `200` + успешная мутация.
**Repro (подтверждено):**
```bash
ID=$(curl -s -X POST localhost:3100/api/admin/users -H "X-Dev-User-Id: demo_admin" -H "Content-Type: application/json" --data-binary '{"telegram_id":"7779200","first_name":"X","role":"requester"}' | grep -oE '"id":"[^"]+"'|cut -d'"' -f4)
curl -s -X DELETE localhost:3100/api/admin/users/$ID -H "X-Dev-User-Id: demo_admin"          # {"ok":true,"active":0}
curl -s -o /dev/null -w "me=%{http_code}\n" localhost:3100/api/me -H "X-Dev-User-Id: 7779200" # me=200 (!)
curl -s -X POST localhost:3100/api/requests -H "X-Dev-User-Id: 7779200" -H "Content-Type: application/json" --data-binary '{"items":[{"name":"x","qty":1,"price":1}]}'  # {"ok":true,...} создал заявку
```
**Исправление:** во всех трёх ветках после получения юзера проверять статус. Пример хелпера и правок:
```ts
const isActiveUser = (u: { status?: string } | null | undefined): boolean =>
  !!u && u.status !== 'disabled' && u.status !== 'archived';   // при желании также !== 'suspended' / 'pending'

// Bearer:
const [u] = await db.select().from(schema.users).where(eq(schema.users.id, p.uid));
if (isActiveUser(u)) { (req as any).dbUser = u; return next(); }

// initData (существующий юзер):
let u = await userByTelegramId(db, tg.id);
if (u && !isActiveUser(u)) { res.status(401).json({ error: 'Unauthorized' }); return; }
// (авто-создание новых остаётся со status:'active')

// dev:
const u = await userByTelegramId(db, devId);
if (!isActiveUser(u)) { res.status(401).json({ error: 'Unauthorized' }); return; }
```

---

### 🔴 BUG-02 — `receive-close` обходит всю цепочку согласований
**Файл:** `src/http/compat.routes.ts:731-764`.
**Экран дизайна:** экран «Приёмка» (кнопка закрытия по приёмке).
**Что не так:** эндпоинт переводит заявку в `status='approved'` (отдаётся дизайну как `closed`) **без проверки текущего статуса заявки** и **без проверки холдинга/доступа**. Любой пользователь с ролью `warehouse` (низкодоверенная роль) «утверждает» ЛЮБУЮ заявку, минуя `dept_head→warehouse→procurement→finance→director→owner` и PIN-подпись. Фактически это обход авторизации расходов.
**Ожидание:** закрывать можно только заявку, реально дошедшую до приёмки (после полного согласования), и только в своём холдинге.
**Реальность:** свежесозданная заявка на этапе `dept_head` → `closed`.
**Repro (подтверждено):**
```bash
RID=$(curl -s -X POST localhost:3100/api/requests -H "X-Dev-User-Id: demo_requester" -H "Content-Type: application/json" --data-binary '{"department":"D","items":[{"name":"x","qty":1,"price":100}]}'|grep -oE '"id":"[^"]+"'|cut -d'"' -f4)
# заявка на этапе dept_head:
curl -s localhost:3100/api/requests/$RID -H "X-Dev-User-Id: demo_owner" | grep -oE '"status":"[^"]+"'   # "status":"dept_head"
curl -s -X POST localhost:3100/api/requests/$RID/receive-close -H "X-Dev-User-Id: demo_warehouse" -H "Content-Type: application/json" --data-binary '{}'   # {"ok":true,"status":"closed"}  ← обход!
```
**Исправление:** добавить (а) проверку холдинга и (б) гейт по состоянию — закрывать можно только заявку, прошедшую согласование (например `status === 'approved'` или статус доставки/приёмки), а не `pending_approval`/`draft`/`rejected`:
```ts
const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
if (!rq) { res.status(404).json({ error: 'Not found' }); return; }
if (rq.holdingId !== u.holdingId) { res.status(403).json({ error: 'Forbidden' }); return; }
const RECEIVABLE = ['approved', 'in_delivery', 'receiving'];
if (!RECEIVABLE.includes(rq.status)) { res.status(409).json({ error: 'Заявка ещё не согласована' }); return; }
```

---

### 🟠 BUG-03 — RBAC гейтит по имени роли; каталог прав (`rbac.ts`) мёртв в боевом API
**Файл:** `src/http/compat.routes.ts:783-799` (`ADMIN_ROLES`, `requireAdmin`, `canAssignRole`) и все `/admin/*` маршруты `:821-1028`.
**Экран дизайна:** Админ-панель (Пользователи / Workflow / Настройки).
**Что не так:** все `/admin/*` гейтятся по **имени роли** через `ADMIN_ROLES = ['owner','admin','director']` (берётся `primaryRole`), а функция `rbac.hasPermission()` (`src/rbac/rbac.ts:38`) в compat-API **не вызывается нигде**. Следствия:
- По `src/rbac/system-roles.ts` у `director` НЕТ прав `users.manage` / `workflows.manage` / `settings.manage` — но он получает полное управление пользователями, ролями, workflow и настройками.
- Любая переконфигурация прав через «конструктор» (мэппинг роль→права в БД) **не влияет** на боевой API — гейт смотрит только на имя роли.
**Ожидание:** доступ к админ-действиям — по гранулярным правам (`users.manage`, `workflows.manage`, `settings.manage`, `roles.manage`), как описано в каталоге.
**Реальность:** доступ по имени роли; каталог прав игнорируется.
**Repro (подтверждено):**
```bash
curl -s -o /dev/null -w "director /admin/users=%{http_code}\n" localhost:3100/api/admin/users -H "X-Dev-User-Id: demo_director"   # 200
curl -s -X POST localhost:3100/api/admin/users -H "X-Dev-User-Id: demo_director" -H "Content-Type: application/json" --data-binary '{"telegram_id":"7779001","first_name":"By","role":"procurement"}'   # {"ok":true} — создал и назначил роль
```
**Исправление:** заменить role-name-гейт на проверку прав через `hasPermission(db, userId, code, { holdingId })`. Маппинг по маршрутам:
- `GET /admin/users` → `users.view`; `POST/PATCH/DELETE /admin/users*` → `users.manage`; назначение роли (`role` в body) → дополнительно `roles.manage`.
- `GET/PATCH /admin/workflow*` → `workflows.manage`.
- `GET/PUT /admin/settings` → `settings.manage`.
`canAssignRole` оставить как defense-in-depth (он корректно не даёт `director`/`admin` выдать `owner` — это работает, см. §3).
Пример:
```ts
import { hasPermission } from '../rbac/rbac.js';
async function requirePerm(req: Request, res: Response, code: string) {
  const u = (req as AuthedReq).dbUser;
  if (!u.holdingId || !(await hasPermission(db, u.id, code, { holdingId: u.holdingId }))) {
    res.status(403).json({ error: 'Forbidden' }); return null;
  }
  return { id: u.id, holdingId: u.holdingId };
}
```

---

### 🟠 BUG-04 — Манипуляция суммой заявки через КП без проверки доступа
**Файл:** `src/http/compat.routes.ts:506-540` (`POST /requests/:id/quotations`), `:542-564` (`PATCH /quotations/:id/select`).
**Экран дизайна:** карточка заявки → блок КП (добавить/выбрать поставщика).
**Что не так:** оба маршрута проверяют только роль (`procurement/owner/admin/director`), но **не вызывают `canAccessRequest`/проверку холдинга**. Любой `procurement` ставит произвольную сумму на **чужую** заявку, и `select` переписывает `requests.estimatedAmount` (это вход в тиринг согласования finance≥5M/director≥30M/owner≥100M). Межтенантно — может менять суммы заявок другого холдинга.
**Ожидание:** добавлять/выбирать КП можно только в рамках доступной заявки своего холдинга.
**Реальность:** `total_amount` чужой заявки переписывается на 999 000 000.
**Repro (подтверждено):**
```bash
RID=$(curl -s -X POST localhost:3100/api/requests -H "X-Dev-User-Id: demo_requester" -H "Content-Type: application/json" --data-binary '{"items":[{"name":"x","qty":1,"price":1000}]}'|grep -oE '"id":"[^"]+"'|cut -d'"' -f4)
Q=$(curl -s -X POST localhost:3100/api/requests/$RID/quotations -H "X-Dev-User-Id: demo_procurement" -H "Content-Type: application/json" --data-binary '{"supplier_name":"ACME","amount":999000000}'|grep -oE '"id":"[^"]+"'|cut -d'"' -f4)
curl -s -X PATCH localhost:3100/api/quotations/$Q/select -H "X-Dev-User-Id: demo_procurement" -H "Content-Type: application/json" --data-binary '{}'   # {"ok":true,"total_amount":999000000}
```
**Исправление:** в обоих маршрутах после загрузки заявки (для `select` — через `quotation.requestId`) проверять холдинг/доступ:
```ts
if (!rq || rq.holdingId !== u.holdingId) { res.status(403).json({ error: 'Forbidden' }); return; }
```
Рекомендуется также запрещать выбор КП на завершённой заявке (`status ∈ {approved, rejected}`), иначе сумма меняется уже после закрытия.

---

### 🟠 BUG-05 — IDOR-запись вложений
**Файл:** `src/http/compat.routes.ts:585-622` (`POST /requests/:id/attachments`). Для сравнения: `GET` той же сущности (`:569-583`) доступ ПРОВЕРЯЕТ.
**Экран дизайна:** карточка заявки → загрузка вложения.
**Что не так:** `POST` не вызывает `canAccessRequest` и не сверяет холдинг — пишет вложение на любую заявку по id. Пользователь без доступа к заявке (403 на чтение) спокойно загружает в неё файл (200).
**Repro (подтверждено):** `7779004` — посторонний `requester`, `RID` принадлежит `demo_requester`:
```bash
curl -s -o /dev/null -w "read=%{http_code}\n" localhost:3100/api/requests/$RID -H "X-Dev-User-Id: 7779004"   # 403
curl -s -X POST localhost:3100/api/requests/$RID/attachments -H "X-Dev-User-Id: 7779004" -H "Content-Type: application/json" --data-binary '{"filename":"evil.txt","mime":"text/plain","data_base64":"aGk="}'   # {"ok":true} (!)
```
**Исправление:** зеркалить проверку из `GET` перед вставкой:
```ts
const [rqA] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
const roleA = u.holdingId ? await primaryRole(db, u.id) : 'requester';
if (!rqA || !canAccessRequest(roleA, u.id, u.holdingId, rqA)) { res.status(403).json({ error: 'Forbidden' }); return; }
```

---

## 3. Детали — medium / low

### 🟡 BUG-06 — `/approvals` не отдаёт `items[]`
**Файл:** `src/http/compat.routes.ts:317-335` (сериализатор очереди согласований).
**Экран дизайна:** карточка согласования, блок «Позиции заявки» (`index.html:730-737`, гейт `a.hasItems`; маппинг `a.items` — `:1785-1786`). Согласующие (dept_head/finance/director/owner) видят карточку **без позиций** и согласуют деньги вслепую (позиции есть только если открыть детальную карточку).
**Реальность:** ни один объект `/approvals` не содержит ключ `items`.
**Исправление:** добрать позиции по `reqIds` и прокинуть как в `/requests` (`:154-160`):
```ts
const its = reqIds.length ? await db.select().from(schema.requestItems).where(inArray(schema.requestItems.requestId, reqIds)) : [];
const itemsByReq = new Map<string, any[]>();
for (const it of its) { (itemsByReq.get(it.requestId) ?? itemsByReq.set(it.requestId, []).get(it.requestId)!).push(it); }
// в .map(...) добавить:
items: (itemsByReq.get(rq.id) ?? []).map((it:any) => ({ name: it.name, qty: Number(it.quantity), unit: it.unit ?? 'шт', code: '', price: it.estimatedPrice })),
```

### 🟡 BUG-07 — `/approvals` всегда `department:""` и `warehouse:""`
**Файл:** `src/http/compat.routes.ts:326` (`department: ''`), `:333` (`warehouse: ''`).
**Экран дизайна:** заголовок карточки `REQ-… · {department}` (`:1772`), подзаголовок `requester · dept` (`:706` показывает `—`), чип «Склад» (`:2091/740-743`) не появляется.
**Реальность:** поля захардкожены пустыми, хотя `rq.departmentName`/`rq.warehouseName` есть (видны в `/requests`).
**Исправление:** `department: rq.departmentName ?? ''`, `warehouse: rq.warehouseName ?? ''`.

### 🟡 BUG-08 — Админ-пороги сумм отсутствуют в ответе И не влияют на движок
**Файл:** `src/http/compat.routes.ts:939-950` (`GET /admin/settings`), `:952-971` (`PUT`). Пороги движка зашиты в шагах: `src/db/tenant-setup.ts:23-30` (5M/30M/100M), применяются как `workflowSteps.thresholdAmount` (`:80-89`); движок читает их в `src/workflow/engine.ts:51`.
**Экран дизайна:** Админка → Настройки, три поля «Порог Замдиректора/Директора/Учредителя (сум)» (`index.html:2322-2324`, ключи `amount_threshold_deputy/director/owner`).
**Что не так:** (1) `GET /admin/settings` не возвращает эти ключи → поля пустые; (2) даже если задать их через `PUT`, движок их **игнорирует** — пороги берутся из `workflow_steps`, а не из `settings`. Настройка мёртвая.
**Исправление (выбрать одно):**
- **Минимум:** в `GET` отдавать текущие пороги из `workflow_steps` под ключами `amount_threshold_*`, чтобы поля заполнялись.
- **Правильно:** связать настройки с движком — `PUT amount_threshold_*` пишет в `workflowSteps.thresholdAmount` соответствующего шага (finance/director/owner), а `GET` читает оттуда же. Учесть, что дизайнерский лейбл «Замдиректора» соответствует шагу `finance` (порог 5M).

### 🟡 BUG-09 — `override` не проверяет холдинг/доступ
**Файл:** `src/http/compat.routes.ts:417-421`. Загружает заявку по id, проверяет только роль `owner` и PIN, но **не сверяет `rq.holdingId === u.holdingId`** и не зовёт `canAccessRequest`. Учредитель холдинга A может продавить (approve/cancel) заявку холдинга B по id. Проверка «уже завершена» (`:422`) присутствует — оставить.
**Исправление:** добавить после загрузки `rq`:
```ts
if (rq.holdingId !== u.holdingId) { res.status(403).json({ error: 'Forbidden' }); return; }
```

### 🟡 BUG-10 — `/approvals` `needed_by` — сырой ISO-таймстамп
**Файл:** `src/http/compat.routes.ts:330` (`needed_by: rq.neededDate ?? null`).
**Экран дизайна:** чип «Нужна к» (`:1782/2090`) показывает `2026-07-15T00:00:00.000Z` вместо даты. Соседние эндпоинты (`/requests`, `/requests/:id`) отдают `YYYY-MM-DD` через хелпер `fmtDate`.
**Исправление:** `needed_by: fmtDate(rq.neededDate)`.

### ⚪ BUG-11 — `/dashboard` `activity[].time` всегда пустой
**Файл:** `src/http/compat.routes.ts:108-114` (`time: ''`). Колонка времени в «Последних событиях» (`index.html:183`) всегда пустая. Данные есть — `dashboard.service` отдаёт `updatedAt`.
**Исправление:** заполнять, например коротким временем/датой:
```ts
time: a.updatedAt ? new Date(a.updatedAt as string).toISOString().slice(0, 10) : '',
```

### ⚪ BUG-12 — Нет гарантии единственного активного workflow
**Файл:** `src/http/compat.routes.ts:813-819` (`activeWorkflow` берёт `[0]`), `src/services/request.service.ts:61-72` (`selectWorkflow` через `.find()/[0]`). Оба без `ORDER BY` и без ограничения «один активный workflow на (holding, requestType)». Сейчас workflow один — не стреляет. При 2+ активных админка будет править недетерминированно выбранный workflow, а движок маршрутизировать по другому.
**Исправление:** добавить детерминированный выбор (`ORDER BY created_at ASC LIMIT 1`) и/или enforce одного активного workflow на тип (частичный уникальный индекс по `is_active`).

---

## 4. Ложные срабатывания / НЕ чинить

- ❌ **`POST /requests` с пустым `needed_by` → 500.** НЕ воспроизводится. Код `neededDate: body.needed_by ? new Date(body.needed_by) : null` (`compat.routes.ts:193`): пустая строка falsy → `null`. Пустой / отсутствующий / валидный `needed_by` → все **200**. (Изначальный «500» в авто-аудите был транзиентной ошибкой Neon под параллельной нагрузкой.)
- ❌ **«Порча кириллицы»** — артефакт curl на Windows, не баг.
- ⚠️ **«Мигание» `enabled` у шагов workflow** между чтениями во время тестов — это read-after-write рассинхрон Neon при connection-per-query под нагрузкой PATCH-ами; не дефект логики (3 чтения в одном коннекте — стабильно). Состояние сидов восстановлено (все 6 шагов `enabled=true`).

---

## 5. Что РАБОТАЕТ корректно (НЕ ломать при правках; проверено живьём)

- **Тиринг цепочки** (заявка 50M): `dept_head→warehouse→procurement(in_stock=false)→finance(≥5M)→director(≥30M)→closed`, **owner корректно пропущен** при <100M.
- **Ветка «нет на складе»**: `procurement` включается при `in_stock=false`, пропускается при `true`.
- **PIN fail-closed** на finance/director/owner: без PIN и с неверным — отказ; с верным — проходит.
- **Разделение обязанностей**: нельзя согласовать свою заявку (403, `approval.service.ts:70`).
- **Проверка полномочий**: нельзя обработать этап, чью роль не держишь (403, `approval.service.ts:88-90`).
- **Идемпотентность**: повторный `approve` → conflict; частичный уникальный индекс «одно pending на заявку» (`schema.ts:440`).
- **Склад**: гейт роли на приёмку (requester→403), отказ на отрицательное/нулевое кол-во, баланс меняется только через движение, атомарно.
- **Создание заявки** сохраняет `department/warehouse/needed_by` (round-trip), деньги — `bigint`, всё в одной транзакции.
- **IDOR-чтение** заявок закрыто (посторонний requester→403); `canAssignRole` не даёт выдать роль `owner` (director/admin→403).
- Все статусы `/requests` резолвятся в метки `STATUS` дизайна.

---

## 6. Приоритет исправления

1. **Сначала critical:** BUG-01 (status-чек в auth), BUG-02 (state+holding в receive-close).
2. **Затем high (общий паттерн — отсутствие scope/permission-проверок):** BUG-03, BUG-04, BUG-05. Корень — слой совместимости пропускает проверки доступа/прав, которые есть в новом API/сервисах. Стоит ввести единые хелперы `requireRequestAccess(req, id)` и `requirePerm(req, code)` и применить везде.
3. **medium/low:** контрактные правки `/approvals` (BUG-06/07/10) и `/dashboard` (BUG-11) — мелкие правки сериализаторов; BUG-08/09/12 — по возможности.

После каждого блока: `npm run typecheck` + `npm test`, затем повтор curl-репро из соответствующего пункта — должно вернуть ожидаемый код/форму.
