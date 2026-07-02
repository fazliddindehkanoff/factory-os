# Factory OS — Полный READ-ONLY аудит на соответствие ТЗ

**Дата:** 2026-07-02
**Аудитор:** Claude Fable 5 (5 параллельных read-only агентов + независимая верификация по файл:строка)
**Режим:** строго read-only — код не менялся, файлы не редактировались.
**Проверено:** 95 файлов исходников (`src/` + `web/src/`, ~18 600 строк TS/TSX), схема БД, 11 миграций, 16 служебных скриптов, 31 тест-файл, доки `docs/`, деплой.
**Baseline (запущен фактически):** `npm run typecheck` ✅ · `npm test` ✅ **175/175 в 31 файле** · `tsc + vite build` (web) ✅ 340.8 kB · backend `tsc -p .` ✅.

> ⚠️ Оговорка по методу: динамического прогона UI в браузере/Telegram не делалось (нет доступа к живому стенду и БД). Все выводы — из чтения кода, тестов и статических проверок. Там, где нельзя было проверить исполнением, помечено «by design / нужен ручной прогон».

---

## 1. Executive Verdict

**Общий вывод.** Factory OS — это НЕ то, что описано в ТЗ как «AI-powered Factory OS с Sidebar/Topbar/UniversalTable/Finance/Documents/DNA-панелью». По факту это **аккуратно сделанный мобильный Telegram Mini App для одного сквозного процесса «заявка → согласование (PIN) → склад → выдача → закрытие»** с сильным RBAC-ядром и data-driven workflow-движком. Ядро (движок статусов, approvals, склад-леджер, аудит, авторизация) написано на удивление добротно: транзакции, `FOR UPDATE`-локи, DB-инварианты, fail-closed, идемпотентность, separation-of-duties, scrypt-PIN с локаутом. **Критичных P0-дыр в каноническом слое не найдено.**

Но по отношению к ТЗ система закрывает примерно **треть заявленного функционала**. Целые контуры отсутствуют полностью: **Finance (инвойсы/платежи/сверка), Budgeting, Documents/OCR, AI Insights, Reports, Notification Center, резервирование склада, полноценный диалоговый Telegram-бот**. Desktop-часть ТЗ (Sidebar на 15 разделов, Topbar, UniversalTable) не реализована — вместо неё мобильный BottomNav на 7 табов.

| Вопрос | Ответ |
|---|---|
| Соответствует ли проект требованиям ТЗ? | **Частично (~35%).** Ядро процесса — да; ~10 модулей из ТЗ отсутствуют |
| Готов ли Mini App? | **Как узкий инструмент — да; как «Mini App из ТЗ» — нет** (~55% мобильного, ~20% бот-слоя) |
| Готов ли Factory OS как система? | **Нет** — нет финансов, документов, отчётов, уведомлений-центра |
| Можно как demo? | **ДА** — golden path (заявка→директор с PIN→склад→выдача→закрытие) работает и покрыт e2e-тестом |
| Можно как pilot? | **УСЛОВНО ДА** для процесса заявок/согласований/склада — при `SERVE_DESIGN=0`, закрытии P1 и организационном обходе отсутствующего финконтура |
| Можно в production? | **НЕТ** до закрытия P0/P1 (незащищённые wipe-скрипты, риски compat-слоя, guard-ы сидов, секрет в git remote) |
| Главные риски | 1) `scripts/reset-tenant.ts` стирает весь audit_log без guard; 2) GitHub PAT в открытую в URL git remote; 3) compat-слой (`SERVE_DESIGN=1`) — эскалация прав и обход финконтроля; 4) guard-ы demo-сидов зависят от явно выставленного `NODE_ENV`; 5) отсутствие всего финансового контура |

---

## 2. Readiness Percentages

| # | Область | % | Обоснование |
|---|---|---|---|
| 1 | Frontend Dashboard (по ТЗ) | **35%** | Есть качественный мобильный Mini App, но нет Sidebar/Topbar/UniversalTable/KPI-панели/Finance/Documents/Reports экранов |
| 2 | Telegram Mini App / Bot | **Mini App 55% · Bot 20%** | Mini App живой и связан с API; бот = только уведомления + кнопка запуска. Нет `/link`-кодов, `telegram_sessions`, `/cancel`, диалогов, PIN-в-чате |
| 3 | Backend / API | **70%** | Канонический слой добротен (auth, RBAC, scope, tx, audit). Минусы: нет zod на телах, нет финансовых endpoint-ов, риски compat |
| 4 | Database | **65%** | Ядро схемы грамотное (enum, partial-unique, bigint-деньги, идемпотентность). Нет 10 таблиц ТЗ (весь финконтур + documents + notifications) |
| 5 | RBAC / Permissions | **75%** | 18 ролей, 24 перма, scope-aware анти-эскалация, SoD, fail-closed. Минус: scope не применяется к чтению списков (holding-wide) |
| 6 | Request lifecycle | **70%** | 8-звенная цепочка работает и покрыта e2e. Нет submitted/cancelled как статусов, нет резерва, нет реального finance-шага |
| 7 | Warehouse | **60%** | receive/issue атомарны, идемпотентны, без отрицательного стока. Нет reserve/adjust/transfer (таблицы мертвы) |
| 8 | Procurement | **45%** | Есть quotations + выбор поставщика + single-quote warning. Нет compare-автоматики, price-anomaly, blacklist, PO |
| 9 | Finance | **10%** | Только шаг `finance_payment` + `mark_paid` с PIN. Нет invoices/payments/partial/сверки/bank_reference |
| 10 | Documents / OCR | **8%** | Только `attachments` (base64 к заявке). Нет documents/document_links/типов/OCR/подписи документов |
| 11 | Approvals / Signatures | **70%** | approve/reject с PIN, signatures, идемпотентность, SoD. Нет delegate/add-signer/changes_requested (enum есть, кода нет) |
| 12 | AI Insights | **0%** | Не реализовано; в схеме нет ai_insights/anomaly_logs. В коде AI нет |
| 13 | DNA / Audit | **65%** | audit_logs с old/new/source/role-snapshot, транзакционно. Минус: immutable только по конвенции, не пишется device/ip/роль-актёра, wipe-скрипт стирает |
| 14 | Notifications | **25%** | Только Telegram fire-and-forget без retry/очереди/статуса. Нет таблицы notifications, нет in-app центра, нет приоритетов |
| 15 | Security | **70%** | Сильная крипта (initData HMAC+timing-safe, scrypt-PIN+lockout, HMAC-сессии, dev-auth gating, env fail-fast). Минус: PIN-reset без re-auth, IDOR-оракул 403/404, TLS rejectUnauthorized:false |
| 16 | Deployment | **50%** | Есть nginx (HSTS/заголовки), backup.sh, env-валидация. Минус: секрет в git remote, guard-ы сидов, нет CSP/offsite-backup, незащищённые скрипты |
| 17 | **Overall Factory OS** | **~38%** | Сильное узкое ядро, но большая часть модулей ТЗ отсутствует |

---

## 3. Что реально работает (конкретно)

- **Golden path** заявка → согласование с PIN → проверка склада (in_stock/out_of_stock ветвление) → выдача → закрытие. Покрыт `src/services/full-chain-e2e.test.ts` (8-звенная out-of-stock цепочка) и `pilot-golden-path.test.ts`.
- **Data-driven workflow-движок** (`src/workflow/engine.ts`): шаги из БД, фильтр по `enabled`/`thresholdAmount`/`conditionRule` (amountGte/amountLt/inStock/requestType), движение только вперёд. Чистые функции, 10 тестов.
- **Approvals**: PIN (scrypt+salt+pepper, timing-safe), lockout 5 попыток/15 мин, идемпотентность (row-lock + partial-unique `approvals_one_pending_idx`), SoD (нельзя одобрить свою), только текущий approver в scope.
- **Склад-леджер**: атомарный `UPDATE ... WHERE available_qty >= qty` (отрицательный сток невозможен), `FOR UPDATE`, идемпотентность движений по ключу (request, material, type, step, warehouse), CHECK-констрейнт `available_qty >= 0`.
- **RBAC**: 18 системных ролей, 24 permission-кода, scope-aware `hasPermission`, анти-эскалация в админке (нельзя выдать право/роль выше своего scope), mgmt пользователей/ролей/workflow/форм.
- **Auth/Security**: Telegram initData с HMAC-проверкой + replay-защита (auth_date ≤24ч), HMAC-сессии 7 дней с per-request перечиткой юзера (мгновенный отзыв через архив), dev-auth fail-closed (boot-fail при утечке флага на prod), env fail-fast на секреты.
- **Конструктор форм** (FormBuilder) — заявки строятся из настраиваемой схемы (`GET /form/request_create`), системные поля защищены.
- **Procurement-lite**: quotations (сумма>0, поставщик по id/free-text), выбор поставщика (ровно один selected, фиксация суммы), warning при единственном КП, H1-инвариант «threshold-шаг не раньше procurement».
- **Frontend-качество**: ни одного мокнутого экрана, повсеместные loading/empty/error-состояния, double-submit-локи, digits-only маски сумм/PIN, confirmDialog через Telegram API, серверная схема форм, продуманная деградация.
- **UI-состояния и валидация Create Request**: required пошагово, отрицательные количества блокируются, qty≤0 при наличии позиции — ошибка.

---

## 4. Что работает частично

- **Статусный движок**: 8-звенная цепочка есть, но нет `submitted` (заявка сразу на первом шаге), нет реального `cancelled` (owner-override пишет `rejected`), `closed` забыт в 3 списках терминальных статусов (dashboard, admin in-flight guard, override-гейт).
- **Warehouse**: receive/issue — да; reserve/adjust/transfer — нет (таблица `reservations` и `reservedQty` мертвы, `wh_in_stock` ставит только флаг → между проверкой и выдачей сток может уйти).
- **Procurement**: КП и выбор есть; compare-автоматики, price-anomaly, blacklist, purchase_orders — нет; КП можно привязать к деактивированному поставщику.
- **Notifications**: Telegram-уведомления на ключевые переходы есть, но fire-and-forget без retry/персистенции; legacy/override-пути не шлют ничего; нет in-app центра/приоритетов/таблицы.
- **Audit/DNA**: пишется транзакционно с old/new/source/role-snapshot, но не заполняются device/ip, не пишется роль-актёра, immutable лишь по конвенции; неудачная выдача склада попадает только в app-log, не в DNA.
- **Telegram-бот**: 9 команд, но 7 из них — один обработчик «текст + кнопка Mini App»; ролевое меню фиксируется на `/start`.
- **Dashboard (mobile)**: 3 метрики (myActive/pendingForMe/totalActive), честно помечено «not faked»; богатых KPI из ТЗ нет.

---

## 5. Что отсутствует полностью

- **Finance-контур**: invoices, payment_requests, payments, partial payment, сверка счёт↔КП, bank_reference, duplicate-payment detection. Шаг `finance_payment` только переключает статус.
- **Budgeting**: budgets, budget_lines, forecast, budget-risk — ничего.
- **Documents/OCR**: documents, document_links, document_types, versioning, OCR-пайплайн, классификация, извлечение полей, подпись документов. Только base64-attachments к заявке.
- **AI-модули**: все 14 из ТЗ (import assistant, OCR, duplicate detection, anomaly, reconciliation, executive assistant и т.д.) — 0%.
- **Reports**: `reports.view` есть как permission, но ни один endpoint его не использует; экрана нет.
- **Notification Center** (in-app), приоритеты, эскалация.
- **Резервирование склада** (таблица есть, кода нет).
- **Delegate / add signer / request changes** в согласовании (enum-значения без кода; reject всегда терминален).
- **Диалоговый Telegram-бот**: `/link` одноразовые истекающие коды, `telegram_sessions`, `/cancel`, `/status`, `/material`, `/upload`, `/ai`, создание заявки/approve из чата, PIN-в-чате.
- **Desktop UI из ТЗ**: Sidebar (15 разделов), Topbar (global search, holding/company/factory switchers, notifications bell, AI ask), UniversalTable (saved views, export CSV/Excel, column pinning/reorder, bulk actions, table DNA log).
- **Register** экран, company-level администрирование (scope-уровень есть, UI нет).

---

## 6. P0 Blockers (нельзя в prod)

**В application-слое (canonical) P0 не найдено.** Все P0 — операционно-инфраструктурные:

### P0-1. `scripts/reset-tenant.ts` уничтожает весь audit_log без guard
**Файл:** `scripts/reset-tenant.ts:56,88` (`tx.delete(schema.auditLogs)`), hardcoded owner TG `8236045489:11`.
**Проблема:** скрипт работает напрямую по `DATABASE_URL` из env без какой-либо проверки окружения. Один запуск с прод-строкой = невосстановимая потеря журнала accountability-системы + удаление всех заявок и пользователей кроме owner.
**Ожидается:** production-guard (`NODE_ENV !== 'production' || FORCE=1`), запрет удаления audit_logs, интерактивное подтверждение.
**Blocker для Factory OS: ДА.**

### P0-2. GitHub PAT в открытом виде в git remote
**Где:** `git remote -v` → `https://tursunovbahtier:ghp_***@github.com/...`.
**Проблема:** персональный токен доступа лежит в конфиге git открытым текстом; любой с доступом к машине/бэкапу получает доступ к репозиторию.
**Ожидается:** ревокнуть токен немедленно, перейти на credential helper / SSH-ключ.
**Blocker: ДА** (утечка учётных данных).

### P0-3. Guard-ы demo-сидов зависят от явно выставленного `NODE_ENV`
**Файл:** `src/db/tenant-setup-cli.ts:24` (`seedDemoUsers = NODE_ENV !== 'production' || FORCE...`), demo-материалы `tenant-setup.ts:186-227` сеются **безусловно**.
**Проблема:** если на прод-сервере `NODE_ENV` не выставлен явно = 'production', в прод попадают demo-юзеры (`demo_owner` и др.) и фиктивные складские остатки. PIN демо-директора/склада — захардкоженный `1234` (`seed-pilot.ts:21`).
**Ожидается:** fail-closed (незаданный NODE_ENV трактовать как prod — как это уже сделано в `env.ts`, но CLI-сиды используют собственную логику), убрать безусловный сид материалов.
**Blocker: ДА при неаккуратном деплое.**

---

## 7. P1 High Priority

### P1-1. Эскалация привилегий через compat `/admin/users` (только `SERVE_DESIGN=1`)
**Файл:** `src/http/compat.routes.ts:939-954` (`canAssignRole`, `setSingleRole`).
`canAssignRole` блокирует лишь owner/director/admin. Держатель только `users.manage` может назначить роль `finance` (даёт `finance.mark_paid` + `approvals.approve`) или `warehouse` кому угодно — минуя scope-aware анти-эскалацию канонической админки. Плюс `setSingleRole` делает **hard-delete** всех userRoles цели (уничтожение истории назначений).
**Ожидается:** привести compat к permission-гейтам и `actorMissingCodes`, как в `admin.routes.ts`. Либо не включать `SERVE_DESIGN=1`.

### P1-2. Обход финконтроля через compat выбор КП после согласования (`SERVE_DESIGN=1`)
**Файл:** `src/http/compat.routes.ts:623-666`.
`PATCH /quotations/:id/select` блокирует только терминальные статусы; на пост-согласовательных шагах можно выбрать более дорогое КП и перезаписать `estimatedAmount` **после** прохождения финансовых порогов. Канонический слой это закрывает (`quote:'select'` только на procurement-шаге + H1-инвариант).

### P1-3. Approve без PIN через compat для кастомных ролей (`SERVE_DESIGN=1`)
**Файл:** `src/http/compat.routes.ts:373-388`.
PIN проверяется только если роль шага ∈ `finance/director/owner`; для любой другой/кастомной роли approval подписывается **без PIN**, а `approval.service.ts:137-142` всё равно пишет signature типа `telegram_pin` — фиктивная подпись в DNA. Канонический `routes.ts:652-676` требует PIN всегда.

### P1-4. Обход amount-гейта самодекларацией цены
**Файл:** `src/services/request.service.ts:133`, `src/workflow/engine.ts:51`; фронт `web/src/App.tsx:972` (`unitPrice: 0` всегда).
`estimatedAmount` при создании = сумма позиций, а фронт **вообще не даёт ввести цену** (unitPrice захардкожен 0). В workflow без procurement-шага (некому «поднять» сумму) пороговые шаги согласования с `thresholdAmount` исключаются навсегда (движок идёт только вперёд). Гард H1 защищает только конфигурации С procurement.

### P1-5. Поиск/фильтр в «Заявки» работает только по загруженной странице
**Файл:** `web/src/App.tsx:672-721,728`.
Серверная пагинация по 30, а поиск/фильтр статуса/календарь фильтруют **клиентски** уже загруженные `rows`. При >30 заявках поиск «не находит» существующие, счётчик «Все заявки · N» врёт, точки календаря неполны. Для фабрики с сотнями заявок — сломанный поиск.

### P1-6. Отсутствие крупных блоков ТЗ
Finance/Budgeting/Documents/Reports/AI/Notification Center + UniversalTable/Sidebar/Topbar. Если ТЗ действующее — это главный функциональный gap (детали в §4/§5).

### P1-7. Уведомления теряются молча
**Файл:** `src/bot/bot.ts:78-84`.
Fire-and-forget `sendMessage().catch(console.error)` — без retry/очереди/статуса доставки. Заблокировал бота → критичное уведомление апруверу теряется навсегда. Legacy/override-пути не шлют вовсе.

---

## 8. P2 Medium

- **P2-1.** Scope-гранулярность не применяется к чтению: factory/department-scoped роль с любым OVERSIGHT-кодом видит заявки (и КП) всего холдинга — `routes.ts:26-32,334-338,525-526`; `rbac.ts:72-92` (осознанное M7-решение, но реальный разрыв конструктора и доступа).
- **P2-2.** `POST /me/pin` и compat `/auth/set-pin` меняют PIN **без старого PIN/re-auth** (`routes.ts:637-650`) — украденный 7-дневный Bearer позволяет переустановить PIN и подписывать деньги.
- **P2-3.** Cross-tenant склад: `warehouse/receive|issue` не валидируют `warehouseId` в холдинге (`routes.ts:825,855`); balances/stock джойнят materials/warehouses без holding-фильтра (`routes.ts:799`, compat `793`) → запись/утечка чужих материалов.
- **P2-4.** IDOR-оракул: `GET /requests/:id` отвечает 403 для чужого холдинга вместо 404 (`routes.ts:478`) — раскрывает существование id, нарушая заявленную политику.
- **P2-5.** Транзакционные пропуски: `DELETE /users/:id` пишет audit ПОСЛЕ tx (`admin.routes.ts:714-731`); suppliers CRUD и `PUT /requests/:id` делают update и audit раздельно.
- **P2-6.** `closed` не признан терминальным: `dashboard.service.ts:29` (закрытые вечно «активны»), `admin.routes.ts:28,144` (workflow не редактируется после первой закрытой заявки), `compat.routes.ts:456` (закрытую можно override-переписать).
- **P2-7.** Заявка может закрыться без движения склада: free-text позиции / qty 0 пропускаются с warning, но шаг receiving/issue завершается (`lifecycle.service.ts:464-475`).
- **P2-8.** Тихая потеря вложений при создании заявки + экран успеха (`App.tsx:976-981` `catch {}`).
- **P2-9.** Нет Telegram BackButton (`telegram.ts:6-11` объявлен, не вызван) — системный «назад» закрывает Mini App с любого экрана.
- **P2-10.** Нет safe-area/fullscreen-буфера в `web/` (в отличие от legacy) — нативная панель Telegram перекрывает хедер.
- **P2-11.** 401 → `window.location.reload()` с потерей ввода посреди мастера (`api.ts:30-33`).
- **P2-12.** PIN-lockout и rate-limit — in-memory Map: сбрасываются рестартом, не работают на нескольких инстансах (`rate-limit.ts:44`).
- **P2-13.** `requests.status` / `request_items.status` — свободный text без CHECK (`schema.ts:412,450`): опечатка в сервисе создаст «невидимую» заявку.
- **P2-14.** Файлы base64 в text-колонке `attachments.data_base64` — раздувание БД, нет object storage.
- **P2-15.** `ssl: { rejectUnauthorized: false }` в `client.ts:10`, `migrate.ts:18` — TLS без проверки сертификата.
- **P2-16.** bot.ts и весь `web/` — 0 тестов (frontend не покрыт вообще).
- **P2-17.** `ON DELETE CASCADE` requests → approvals/history/quotations/attachments — физическое удаление заявки уничтожает историю согласований.
- **P2-18.** Ошибка загрузки dashboard на Home не показывается, карты «—» навсегда (`App.tsx:475`).

---

## 9. P3 Low

- Дубли/мёртвый код: `screens/DevLogin.tsx` мёртв; `screens/shared.tsx` почти целиком продублирован в `App.tsx` (уже привёл к рассинхрону statusMeta); `requestMovedToStepMessage` не вызывается; `dev/set-my-role` возвращает фейковый `{ok:true}`.
- `public/admin.html` + `public/index.html` + `support.js` — легаси-UI (устаревшие роли, 6-значный PIN, «Zelal Tekstil»), доступен при `SERVE_DESIGN=1`; кандидаты на удаление.
- «+ Добавить шаг» FormBuilder — client-only, шаг исчезает без полей (`FormBuilder.tsx:162-164`).
- InviteSheet: частичный успех invite/assignRole (`People.tsx:170-176`).
- `bg-white/5` примитивы невидимы в светлой теме (`admin/ui.tsx:46,88,100`), протекают в Procurement.
- Смешение языков: «Workflow», «custom», сырые коды статусов/source.
- `cancelled` — мёртвый статус; КП к деактивированному поставщику; `neededDate` без Invalid-Date проверки в `PUT` (`routes.ts:750`); `scryptSync` блокирует event loop; несогласованный формат ответов API; required-select автоподставляет первую опцию; `users.holding_id` nullable; нет unique на `user_roles`; `reports.view`/`warehouse.check_stock`/`companyId` — обещаны, не применяются.
- Битые ссылки в доках: `finance-lite.test.ts` и `docs/FINANCE_SMOKE_CHECKLIST.md` не существуют.
- npm audit: 4 moderate (drizzle-kit → esbuild-kit, dev-зависимости).

---

## 10. Frontend Screen-by-Screen (TABLE 2)

| Экран | Route(state) | Есть | Real data | Компоненты | Кнопки OK | Главное отсутствует | Баги | Severity |
|---|---|---|---|---|---|---|---|---|
| Home/Dashboard | `home` | ДА | ДА | частично | ДА | KPI из ТЗ, badges, error-state | dashboard error не виден | P2 |
| Заявки (list) | `list` | ДА | ДА | карточки (не таблица) | ДА | UniversalTable, серверный поиск | поиск/фильтр только по стр. | P1 |
| Создание | `create` | ДА | ДА | ДА | ДА | ввод цены | unitPrice=0, потеря вложений | P1/P2 |
| Деталь | `detail` | ДА | ДА | ДА | ДА | — | alert вместо confirm на attach | P2 |
| Согласования | `approvals` | ДА | ДА | ДА | ДА | delegate/changes | — | P3 |
| Склад | `warehouse` | ДА | ДА | ДА | ДА | reserve/adjust | ручной ввод UUID fallback | P3 |
| Закупки | `procurement` | ДА | ДА | ДА | ДА | compare/blacklist | тёмные примитивы в свете | P3 |
| Меню | `menu` | ДА | ДА | ДА | ДА | — | двойной паддинг | P3 |
| Админка (9 вкл.) | `admin` | ДА | ДА | ДА | почти | — | «+шаг» client-only, invite | P3 |
| **Finance** | — | **НЕТ** | — | — | — | весь экран | — | P1 |
| **Budgeting** | — | **НЕТ** | — | — | — | весь экран | — | P1 |
| **Documents** | — | **НЕТ** | — | — | — | весь экран | — | P1 |
| **Reports** | — | **НЕТ** | — | — | — | весь экран | — | P1 |
| **AI Insights** | — | **НЕТ** | — | — | — | весь экран | — | P2 |
| **Notification Center** | — | **НЕТ** | — | — | — | весь экран | — | P2 |
| **Register** | — | **НЕТ** | — | — | — | самрегистрация | — | P3 |

---

## 11. Role/Permission Audit (TABLE 5, ключевое)

| Роль | Ожид. доступ | Факт | FE скрыт | BE блок | Scope верен | Баг |
|---|---|---|---|---|---|---|
| owner | всё | `all` | — | — | holding | override может approve свою заявку |
| requester | только свои | свои (list/detail visibility) | ДА | ДА | own | — |
| dept_head | заявки отдела | **весь холдинг** | — | — | holding, не dept | нет dept-фильтрации (by design R9) |
| warehouse | склад, без финансов | warehouse.* | ДА | ДА | **holding при factory-scope на чтении** | P2-1: видит все заявки холдинга |
| finance | финансы | finance.view/mark_paid | ДА | ДА | holding | нет реального finance-контура |
| auditor | read-only + audit | audit.view | ДА | ДА | holding | reports.view не применяется |
| admin (IT) | НЕ бизнес-согласование | settings/users/roles/workflows | ДА | ДА | scope-aware | корректно (не approver) |
| observer | только свои | свои | ДА | ДА | own | — |
| кастомная роль с `users.manage` | не выше своего scope | canonical: ✅ | — | ДА | ДА | **compat P1-1: обход анти-эскалации** |

Общий вывод: canonical RBAC — сильный (default-deny, scope-aware анти-эскалация, SoD). Два системных разрыва: (1) scope не применяется к чтению списков; (2) compat-слой гейтит по именам ролей, а не permissions.

---

## 12. Workflow Compliance (TABLE 7)

| Шаг lifecycle | Ожид. | Факт | Отсутствует | Status-переход | DNA | Notif | Severity |
|---|---|---|---|---|---|---|---|
| Need → Request | создание | ДА (`request.service`) | submitted-статус | draft/pending | ДА | ДА | P3 |
| Warehouse check | in_stock/out | ДА (флаг inStock, ветвление) | **reserve** | warehouse_check | ДА | — | P2 |
| Procurement | quotation/select | частично | compare/anomaly/blacklist/PO | procurement | ДА | частично | P2 |
| Approval chain | PIN/signature | ДА | delegate/changes/add-signer | pending_approval | ДА | ДА | P1(compat PIN) |
| Contract/Doc | документы | **НЕТ** | весь documents-контур | — | — | — | P1 |
| Invoice/Finance | инвойс/платёж | **почти НЕТ** | invoices/payments/сверка | finance_payment (только флаг) | ДА | — | P1 |
| Delivery | доставка | ДА (delivery) | — | delivery | ДА | — | P2 |
| Warehouse receiving | приёмка | ДА | accumulative qty | receiving | ДА | — | P2 |
| Issue to dept | выдача | ДА | — | issue | ДА | ДА | — |
| Close | закрытие | ДА | — | closed | ДА | ДА | — |
| DNA log + AI | аудит + обучение | audit ДА / **AI НЕТ** | AI-обучение/insights | — | ДА | — | P2 |

---

## 13. Database/Audit (TABLE 8, кратко)

- **Есть 24 таблицы**, ядро грамотное: FK покрыты, `requests(holding, request_number)` unique, `users.telegram_id` unique, partial-unique «один pending approval», идемпотентный индекс движений, CHECK `available_qty>=0`, деньги в bigint (минорные единицы), enum-контроль статусов approval/movement/reservation, holding_id scoping на всех бизнес-таблицах, archiving вместо hard-delete пользователей.
- **Отсутствует 10 таблиц ТЗ**: purchase_orders, budgets, budget_lines, invoices, payment_requests, payments, documents, document_links, notifications, material_aliases; request_comments — суррогатом в comment-полях.
- **Слабости**: свободный text-статус без CHECK; каскад-delete от requests уничтожает историю; audit immutable только по конвенции; raw-констрейнты 0009/0010 не отражены в schema.ts (тестовая pglite-БД мягче продовой); отсутствует `meta/0009_snapshot.json` (drift).

---

## 14. API/Backend (TABLE 6, кратко)

- **Canonical** (`routes.ts` + `admin.routes.ts`): каждый mutation-endpoint — auth + permission + scope + tx + audit (кроме перечисленных в P2-5). Формат ответов не унифицирован. Валидация — ручная (zod только в `env.ts`).
- **Публичные без auth**: только `/healthz`, `/auth/telegram`, `/auth/dev` (последний stealth-404 в prod) — корректно.
- **Compat** (`SERVE_DESIGN=1`): повторяет старые контракты, местами гейт по именам ролей → источник P1-1/P1-2/P1-3.
- **Мёртвое/фейковое**: `dev/set-my-role`, `reports.view`, `warehouse.check_stock`, `companyId`-уровень, hardcoded requestTypes/urgencies/statuses в `/config`.

---

## 15. Fix Roadmap

### Must fix before demo
- Ничего блокирующего — golden path работает. (Косметика: тёмные примитивы в светлой теме, двойной паддинг меню.)

### Must fix before pilot
1. **P0-2** — ревокнуть GitHub PAT, убрать из git remote (немедленно).
2. **P0-1/P0-3** — production-guard на `reset-tenant.ts`/`clear-requests.ts`/`reset-roles.ts`; fail-closed guard-ы demo-сидов; убрать безусловный сид материалов.
3. **`SERVE_DESIGN=0` на проде обязательно** (закрывает P1-1/P1-2/P1-3 разом). Либо привести compat к permission-гейтам.
4. **P1-4** — дать вводить цену в Create Request (или считать сумму иначе); проверить amount-гейт.
5. **P1-5** — серверный поиск/фильтр в списке заявок.
6. **P1-7** — минимум retry/лог доставки уведомлений; уведомления на override.
7. **P2-2** — требовать старый PIN/re-auth при смене PIN.
8. **P2-3/P2-4** — валидация warehouseId в холдинге, holding-фильтр в join, 404 вместо 403.
9. Организационно закрыть отсутствие финконтроля (ручной процесс) — либо не пилотировать finance-стадию.

### Must fix before production
- Весь список pilot +:
- **Финансовый контур** (invoices/payments/partial/сверка/bank_reference) — если он в scope пилота.
- **P2-6** — признать `closed` терминальным в 3 местах.
- **P2-12** — вынести PIN-lockout/rate-limit в персистентное хранилище (Redis/БД) при кластере.
- **P2-13** — CHECK или enum на статусы заявок.
- **P2-17** — убрать каскад-delete от requests (RESTRICT + correction workflow).
- audit immutability на уровне БД (REVOKE/триггер), заполнять device/ip/роль-актёра.
- CSP в nginx, offsite/шифрованный backup, TLS `rejectUnauthorized: true`.

### Can be later
- UniversalTable/Sidebar/Topbar (desktop-UI из ТЗ), AI-модули, Documents/OCR, Budgeting, Reports, Notification Center, диалоговый бот с `/link`-кодами, reserve, delegate/changes_requested, удаление легаси `public/`, чистка дублей `shared.tsx`↔`App.tsx`.

---

## 16. Final Go / No-Go

| Область | Pilot? | Production? | Причина |
|---|---|---|---|
| Процесс заявок/согласований/склад | **GO** | NO-GO пока P0/P1 | Ядро добротное, e2e-покрыто; блокируют инфра-P0 и compat-P1 |
| Finance | NO-GO | NO-GO | Контур отсутствует (~10%) |
| Documents/AI/Reports/Budgeting | NO-GO | NO-GO | Не реализовано |
| Telegram-бот | GO (как лаунчер+уведомления) | NO-GO как «бот из ТЗ» | ~20% ТЗ; нет диалогов/linking-кодов |

- **Demo: GO** — golden path работает, покрыт тестами.
- **Pilot: УСЛОВНО GO** — только для заявок/согласований/склада, при `SERVE_DESIGN=0`, закрытых P0 + P1-1..P1-5/P1-7 + P2-2/P2-3, и организационном обходе отсутствующего финконтура.
- **Production: NO-GO** — до закрытия всех P0, compat-P1, guard-ов сидов, секрета в git, и решения по финконтуру.

---

## 17. Задачи разработчику (task list)

| # | Prio | Модуль | Файл | Проблема | Ожид. результат | Acceptance |
|---|---|---|---|---|---|---|
| T1 | P0 | Security | git remote | PAT в открытом URL | токен ревокнут, credential helper | `git remote -v` без токена |
| T2 | P0 | Scripts | reset-tenant/clear-requests/reset-roles.ts | wipe без guard, стирает audit | prod-guard + запрет удаления audit | запуск с prod-URL отклоняется |
| T3 | P0 | Seeds | tenant-setup-cli.ts:24, tenant-setup.ts:186 | guard от NODE_ENV, безусловный сид материалов | fail-closed, убрать безусловный сид | незаданный NODE_ENV → нет demo |
| T4 | P1 | Deploy | env/serve | compat даёт эскалацию/обход PIN | `SERVE_DESIGN=0` в prod или permission-гейты в compat | compat недоступен либо гейты как canonical |
| T5 | P1 | Requests | App.tsx:972, request.service.ts:133 | нет ввода цены, amount-гейт обходится | поле цены + проверка порогов | заявка с суммой проходит нужные шаги |
| T6 | P1 | Requests | App.tsx:672-721 | поиск только по странице | серверные search/filter/count | поиск находит заявку вне первой страницы |
| T7 | P1 | Notifications | bot.ts:78-84 | уведомления теряются молча | retry/лог доставки, notify на override | недоставка залогирована/повторена |
| T8 | P2 | Security | routes.ts:637 | PIN-reset без re-auth | требовать старый PIN | смена PIN без старого → 403 |
| T9 | P2 | Warehouse | routes.ts:825,799 | cross-tenant warehouseId/join | валидация + holding-фильтр | чужой warehouseId → 400 |
| T10 | P2 | Lifecycle | dashboard/admin/compat | `closed` не терминален | добавить в 3 списка | закрытая заявка не «активна», workflow редактируется |
| T11 | P2 | DB | schema.ts:412 | статус свободный text | CHECK/enum | невалидный статус отклоняется |
| T12 | P2 | DB | schema.ts (cascades) | каскад-delete истории | RESTRICT + correction | delete заявки с историей запрещён |

---

*Отчёт составлен Fable 5 по данным 5 параллельных read-only агентов и независимой верификации по файл:строка. Код не изменялся. Все проверки baseline (typecheck/test/build) прогнаны фактически и зелёные.*
