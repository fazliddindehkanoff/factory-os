# Sprint 1 — Pilot Dashboard (plan-doc, БЕЗ кода)

Статус: **финальный scope согласован** (4 решения ниже). Реализация — только после отдельного «go».
Принцип: показываем **лишь то, что подтверждается реальными данными/API**. Никаких fake-KPI.

## Согласованные решения (locked)

1. **Department-скоуп — НЕ в этом sprint.** MVP-видимость: «мои» / «весь холдинг». Dept-visibility — отдельный RBAC-sprint позже.
2. **KPI-набор** — как в §1 MVP (My Active, Pending My Approval, Total Active, Awaiting Payment, In Procurement, Low Stock, Unread Notifications, + requests-by-status для oversight).
3. **3 очереди на дашборде, role-aware:** My Approvals + профильная очередь роли (Procurement / Warehouse / Finance) + (My Requests **или** Recent Activity). Обычные роли видят только релевантное; Director/Owner/Auditor — расширенный read-view по правам.
4. **API:** расширяем существующий `GET /dashboard` аддитивными полями. Отдельный `/dashboard/summary` не заводим.

---

## 0. Ограничения, из которых исходим (факты кодовой базы)

- Роли/права: RBAC на 24 permission-кодах (`requests.view`, `approvals.approve`, `procurement.view`, `finance.view`, `warehouse.view`, `audit.view`, `reports.view` и т.д.). KPI и очереди гейтим по правам, не по именам ролей.
- **Видимость сейчас бинарная:** requester/observer видят только свои заявки; oversight-роли — весь холдинг. **Скоупа «по отделу/фабрике» на чтении нет** (это отдельная работа). Дашборд честно отражает: «мои» либо «холдинг».
- Во фронте **нет URL-роутера** — переход «клик по KPI → отфильтрованный список» делаем через state (deep-link по URL пока невозможен).
- Финансового контура нет (только шаг `finance_payment` + `mark_paid`); документов/бюджета/AI нет. Значит соответствующие KPI — **не в этот sprint**.

---

## 1. Какие KPI показываем

### MVP (данные есть или дёшево считаются)
| KPI | Источник | Гейт (право) |
|---|---|---|
| My Active Requests | `GET /dashboard.myActive` (есть) | любой авторизованный |
| Pending My Approval | `GET /dashboard.pendingForMe` / `/requests/inbox` (есть) | `approvals.approve` |
| Total Active (холдинг) | `GET /dashboard.totalActive` (есть) | oversight (`requests.view` + oversight-право) |
| Awaiting Payment | новый агрегат: count `status='finance_payment'` | `finance.view` / oversight |
| In Procurement | новый агрегат: count `status='procurement'` (или длина `/procurement/queue`) | `procurement.view` / oversight |
| Low Stock Items | из `GET /warehouse/balances` где `available_qty <= min_qty` | `warehouse.view` |
| Unread Notifications | `GET /me/notifications/unread-count` (есть) | любой |

### Requests-by-status (мини-разбивка, oversight)
Горизонтальная полоска/список счётчиков по статусам: `pending_approval / procurement / finance_payment / delivery / receiving / issue / closed / rejected`. Источник — новый агрегат (`GROUP BY status`).

### НЕ в MVP (нет данных — §7)
Budget Risk, Missing Documents, Delayed Procurement (нет SLA/таймеров), Supplier Risk, AI Savings, DNA scored alerts, Cashflow.

---

## 2. Какие роли что видят (role → набор карточек/очередей)

| Роль (по правам) | KPI-карточки | Очереди | Активность |
|---|---|---|---|
| Requester / Employee | My Active, Unread | My Requests (свои) | свои события |
| Department Head* | My Active, Pending My Approval, Unread | My Approvals, (свои/холдинг) | холдинг* |
| Warehouse | Low Stock, Unread | Warehouse Tasks (receiving/issue) | склад-события |
| Procurement | In Procurement, Unread | Procurement Queue | procurement-события |
| Finance | Awaiting Payment, Unread | Awaiting Payment queue | finance-события |
| Director / Owner | Total Active, Pending My Approval, by-status | My Approvals, (все очереди read) | холдинг |
| Auditor | (read-only) Total Active, by-status | — | Recent activity / audit feed |

\* Department Head сейчас технически видит холдинг (нет dept-скоупа). В MVP помечаем как «холдинг»; dept-скоуп — отдельная задача (§7).

Правило: карточка/очередь **скрыта**, если нет соответствующего права (как уже сделано в BottomNav/dashboard.config).

---

## 3. Какие очереди выводим (РЕШЕНИЕ: ровно 3, role-aware)

Очередь = список карточек-заявок, строка → открыть Request Detail. На дашборде показываем **3 слота**:

- **Слот 1 — My Approvals** (всегда, если есть право `approvals.approve`): `GET /requests/inbox` ✅.
- **Слот 2 — профильная очередь роли** (одна, по правам):
  - `procurement.view` → **Procurement Queue** (`GET /procurement/queue` ✅)
  - `warehouse.view` → **Warehouse Tasks** (`GET /requests?status=receiving|issue` ✅, P1-7)
  - `finance.view` → **Awaiting Payment** (`GET /requests?status=finance_payment` ✅)
- **Слот 3 — My Requests** (`GET /requests` own ✅) **или** Recent Activity (`/dashboard.activity` ✅) — по роли.

Правила по ролям:
- Обычная роль видит только релевантные слоты (например, requester — только слот 3; warehouse — слоты 1?/2/3 по правам).
- **Director / Owner / Auditor** — расширенный read-view: слот 2 может показывать несколько профильных очередей (по имеющимся правам), Auditor — read-only (без действий).

Все источники уже готовы (server-side фильтр по статусу из P1-7) — **новых эндпоинтов для очередей не требуется**.

---

## 4. Какие фильтры нужны

Переиспользуем готовые server-side параметры `GET /requests` (из P1-7): `search`, `status`, `priority`, `factory_id`, `department_id`, `requester_id`, `responsible_user_id`, `date_from`, `date_to`, `page`.

- **На дашборде:** быстрый фильтр по статусу + поиск (как в списке заявок).
- **Клик по KPI-карточке** → открыть экран «Заявки» с предустановленным фильтром (напр. Awaiting Payment → `status=finance_payment`). Через state (URL-роутера нет).
- Фильтры factory/department присутствуют в API, но пока oversight видит холдинг — в MVP показываем их как опциональные, без обещания строгого скоупа.

---

## 5. Какие API уже есть, а каких не хватает

### Есть (используем как есть)
`GET /dashboard` · `GET /requests` (фильтры + `total`) · `GET /requests/inbox` · `GET /procurement/queue` · `GET /warehouse/balances` · `GET /me/notifications` (+`/unread-count`) · `GET /suppliers`.

### Не хватает (небольшие бэкенд-добавки для MVP)
| Нужно | Предлагаемое решение | Объём |
|---|---|---|
| Счётчики Awaiting Payment / In Procurement / Low Stock + by-status | **Расширить `GET /dashboard`** новыми полями (аддитивно, обратносовместимо): `awaitingPayment`, `inProcurement`, `lowStock`, `byStatus{}` — всё role-scoped и permission-gated | 1 сервис + тесты |
| Low Stock как число | В том же агрегате: count balances `available_qty <= min_qty` по холдингу | входит выше |

Всё — SQL-агрегаты (count/group by), дёшево, без новых таблиц. **Финансовых/бюджетных/документных эндпоинтов MVP не требует.**

---

## 6. Что входит в MVP Dashboard (Sprint 1)

1. **Role-aware KPI-карточки** (§1 MVP-набор) — числа из расширенного `GET /dashboard`, каждая гейтится правом.
2. **Requests-by-status** мини-разбивка для oversight.
3. **2–3 очереди по роли** (§3): минимум My Approvals + одна профильная (Procurement / Warehouse Tasks / Awaiting Payment).
4. **Клик по KPI** → экран «Заявки» с предфильтром.
5. **Recent activity feed** (уже есть в `/dashboard.activity`).
6. **Состояния:** loading / empty / error на каждом блоке; никаких «—» навсегда при ошибке (учесть баг из аудита — показать error-state).
7. **Permission-hiding** карточек/очередей; ничего лишнего роль не видит.

Бэкенд MVP: одно расширение `GET /dashboard` + тесты. Фронт: экран Home v2 из карточек и очередей.

---

## 7. Что оставляем на следующий sprint

- **Budget vs Actual, Missing Documents, Delayed Procurement (SLA), Supplier Risk, AI Insights, DNA scored alerts, Cashflow** — нет данных/модулей.
- **Widget-действия:** export, «show underlying records», drill-down по виджету.
- **Department/Factory-скоуп видимости** (сейчас oversight = весь холдинг) — требует изменения модели доступа.
- **Holding/Company/Factory switcher**, Global Search в topbar.
- **UniversalTable** (saved views, column pinning, bulk) — крупный отдельный компонент.
- **URL-роутинг** для deep-link фильтров/дашборда.

---

## Финальный scope (что делаем в Sprint 1)

- **Backend:** расширить `GET /dashboard` аддитивными полями (role-scoped, permission-gated):
  `awaitingPayment`, `inProcurement`, `lowStock`, `byStatus{ ...counts }`.
  Существующие поля (`myActive`, `pendingForMe`, `totalActive`, `activity`) — без изменений (обратная совместимость).
- **Frontend (Home v2):**
  - Role-aware KPI-карточки (§1 MVP-набор) + requests-by-status для oversight.
  - 3 role-aware слота очередей (§3).
  - Клик по KPI → экран «Заявки» с предфильтром (через state).
  - Recent activity feed (существует).
  - Честные loading / empty / error на каждом блоке; permission-hiding.

### Порядок реализации (после «go»)
1. Backend aggregates в `GET /dashboard` + unit/HTTP-тесты (role-scoping, permission-gating, корректность счётчиков) — сначала бэкенд, красный→зелёный.
2. Frontend Home v2 поверх расширенного `/dashboard` + очереди из готовых эндпоинтов.
3. Прогон: typecheck / tests / build (backend + web) → PR → CI → merge.

### Явно НЕ в этом sprint (§7)
Department/factory-скоуп видимости; Budget/Documents/Delayed-procurement(SLA)/Supplier-risk/AI/DNA-alerts; widget export/drill-down; holding/factory switcher + global search; UniversalTable; URL-роутинг.

> Реализацию начинаем только по отдельной команде. Этот документ — согласованный scope, не стартовый сигнал к коду.
