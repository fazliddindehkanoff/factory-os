# Factory OS Audit Report

**Дата:** 2026-07-02
**Аудитор:** Claude Fable 5 (5 параллельных агентов-аудиторов + независимая верификация ключевых находок прямым чтением кода)
**Режим:** строго READ-ONLY. Код не изменялся. Проверки: `npm run typecheck` ✅, `npm test` ✅ 175/175 (31 файл), `npm run build` ✅, `cd web && npm run build` ✅ (340.8 kB / gzip 93.2 kB).
**Ветка:** `main` (актуальная, HEAD d3b4ddb).

> **Отсутствующие эталонные документы (ТЗ §0):** ни один из 19 файлов `FACTORY_OS_*.txt` (FINAL_WORKFLOWS, ROLE_LOGIC, STATUS_ENGINE, NOTIFICATION_LOGIC, AI_LOGIC, DB_DICTIONARY, API_SPEC, SCREEN_LOGIC, IMPLEMENTATION_PLAYBOOK, SECURITY_AUDIT, METRICS_KPI, TELEGRAM_BOT_LOGIC, UI_COMPONENT_SYSTEM, TECH_ARCHITECTURE, N8N_AUTOMATIONS, ROLE_PERMISSION_MATRIX, DEPLOYMENT_CHECKLIST, SOP_MANUAL, Detailed Logic) в проекте **не найден**. Аудит вёлся против требований самого TZ.txt и внутренних доков `docs/` (ROLE_MATRIX.md, PROCUREMENT_LITE.md, PILOT_SMOKE_CHECKLIST.md и др.).

---

## 1. Executive Verdict

**Что это на самом деле:** Factory OS в текущем виде — это **качественно сделанный «procurement-lite» Telegram Mini App** (заявка → data-driven workflow согласований с PIN-подписью → проверка склада → закупка-lite (КП/выбор поставщика) → отметка оплаты → приёмка → выдача → закрытие), с сильным ядром: транзакции, row-locks, DB-инварианты, RBAC с конструктором ролей, SoD, audit log, идемпотентность складских операций.

**Что это НЕ:** это не тот «Factory OS» из ТЗ. Desktop Dashboard (Sidebar/Topbar/UniversalTable/KPI-панели), финансовый контур (invoices/payment requests/payments/partial payment/сверки), Budgeting, Documents/OCR, все 14 AI-модулей, Reports, Notification Center, диалоговый Telegram-бот (linking-коды, FSM-флоу, approve из чата) — **отсутствуют полностью или почти полностью**.

- **Соответствует ли проект требованиям ТЗ?** Частично: реализовано ядро lifecycle (~50% общего скоупа ТЗ), причём реализованная часть сделана добротно и честно (моков «под живое» нет — чего нет, того нет и в UI).
- **Mini App готов?** Как мобильный инструмент заявок/согласований/склада/закупки-lite — **близок к готовности для пилота** (после условий ниже).
- **Factory OS как система из ТЗ готов?** **Нет.** Отсутствуют целые контуры (финансы, документы, AI, отчёты).
- **Demo:** ДА (seed:pilot + golden path работают детерминированно).
- **Pilot:** ДА, с условиями (см. §24).
- **Production:** НЕТ (см. §24).
- **Крупнейшие риски:** (1) незащищённые wipe-скрипты, стирающие ВЕСЬ audit log и заявки против прода; (2) legacy compat-слой (SERVE_DESIGN=1) с эскалацией привилегий и обходом финконтроля; (3) GitHub PAT открытым текстом в git remote URL; (4) уведомления fire-and-forget без персистенции — потеря уведомления апруверу теряется молча; (5) обход amount-гейта самодекларацией цены в workflow без procurement-шага.

**P0 в каноническом рантайме не найдено** — это результат 4 предыдущих циклов аудита/фиксов (комментарии-маркеры B2/C1/H1/M2/M6/M12/M13 в коде, 175 тестов). Найденные P0 — операционные (скрипты, секреты), P1 — в legacy-слое и конфигурационных дырах движка.

---

## 2. Readiness Percentages

TABLE 1 — Executive Summary

| # | Area | Readiness | Status | Главные блокеры | Prod-риск |
|---|---|---|---|---|---|
| 1 | Frontend Dashboard (по ТЗ: Sidebar/Topbar/UniversalTable/KPI) | **15%** | ❌ | Таблиц/сайдбара/топбара/KPI-панелей нет; есть мобильный Mini App | Высокий (несоответствие ожиданиям) |
| — | Frontend Mini App (фактическая реализация) | **75%** | ✅/⚠️ | Клиентский поиск по 1 странице, BackButton/safe-area, потеря вложений | Средний |
| 2 | Telegram Bot | **20%** | ❌ | Бот = уведомления + кнопка WebApp; нет /link-кодов, FSM, approve из чата, PIN в чате | Средний |
| 3 | Backend/API | **60%** | ⚠️ | Нет finance/documents/AI endpoints; двойной вход (canonical vs compat) с разной строгостью | Средний |
| 4 | Database | **65%** | ⚠️ | 24 из 37 таблиц ТЗ; нет invoices/payments/budgets/documents/notifications; cascade-удаление истории | Средний |
| 5 | RBAC/Permissions | **75%** | ✅/⚠️ | Scope factory/department не применяется к чтению; compat обходит анти-эскалацию | Средний |
| 6 | Request lifecycle | **70%** | ✅/⚠️ | Нет draft→submit, cancelled, changes_requested, delegate; `closed` забыт в 3 списках терминальных | Средний |
| 7 | Warehouse | **50%** | ⚠️ | receive/issue сильные; НЕТ reserve (таблица мертва), adjust, transfer, aliases, min-stock alerts | Средний |
| 8 | Procurement | **45%** | ⚠️ | КП+выбор поставщика есть; нет RFQ, сравнения, price anomaly, blacklist, PO | Средний |
| 9 | Finance | **10%** | ❌ | Только шаг mark_paid (PIN+SoD); нет invoices/payment requests/payments/partial/сверок | **Блокер прода** |
| 10 | Documents/OCR | **15%** | ❌ | Только attachments (base64 в БД, ≤2MB); нет типов документов, OCR, versioning, sign | Блокер прода |
| 11 | Approvals/Signatures | **65%** | ✅/⚠️ | PIN+signatures+SoD+идемпотентность сильные; нет delegate/add signer/changes_requested | Низкий |
| 12 | AI Insights | **0%** | ❌ | Ни одного из 14 AI-модулей ТЗ | — (не обещано в коде) |
| 13 | DNA/Audit | **60%** | ⚠️ | audit_logs с old/new/source + история статусов; иммутабельность только по конвенции; deviceInfo/ip не пишутся; reset-tenant.ts стирает | Высокий (из-за скриптов) |
| 14 | Notifications | **30%** | ❌ | Только Telegram fire-and-forget; нет таблицы, retry, in-app центра; compat-слой не шлёт вовсе | Высокий |
| 15 | Security | **70%** | ✅/⚠️ | Ядро сильное (scrypt, HMAC, fail-closed, lockout); PIN-смена без старого PIN; compat-дыры; PAT в remote | Средний |
| 16 | Deployment | **60%** | ⚠️ | env-гигиена образцовая; но wipe-скрипты без guard, нет CSP, backup без offsite | Высокий |
| 17 | **Overall Factory OS (по скоупу ТЗ)** | **≈50%** | ⚠️ | Ядро готово, целые контуры отсутствуют | — |

Обоснование каждой цифры — в профильных разделах ниже (§10–§22).

---

## 3. What Is Already Working (конкретно, с доказательствами)

1. **Полный out-of-stock lifecycle e2e**: заявка → согласование → warehouse_check(out) → procurement (КП → выбор) → согласование по порогу → mark_paid(PIN) → delivery → receiving (приход в ledger) → issue (расход) → close. Покрыт тестом `src/services/full-chain-e2e.test.ts` (10 записей history, баланс сходится) и smoke `src/smoke/golden.ts`.
2. **Data-driven workflow-конструктор**: шаги/роли/пороги/условия из БД (`workflow_steps`, 8 step kinds — `src/workflow/step-kinds.ts:15-23`), чистый движок `engine.ts:47-72`, ветвление in_stock/procurement работает (`workflow-instock-branch.test.ts`).
3. **Approvals**: PIN (scrypt+pepper, timing-safe — `src/auth/pin.ts`), lockout 5 попыток/15 мин (`rate-limit.ts:34-75`), подпись в `signatures`, SoD «не одобряй своё» (`approval.service.ts:79-81` + sod-шаги `step-kinds.ts:76-86`), идемпотентность (row-lock + partial unique `approvals_one_pending_idx`, `schema.ts:489-493`), fail-closed на orphan/терминальных (`approval.service.ts:93-98`).
4. **Склад receive/issue**: атомарный guarded UPDATE (отрицательный остаток невозможен — `warehouse.service.ts:156-171` + CHECK в миграции 0009), FOR UPDATE, идемпотентность по (request, material, type, step, warehouse) — `warehouse.service.ts:103-139`, fail-loud нехватка с откатом транзакции.
5. **RBAC-конструктор**: 18 системных ролей + кастомные, 24 живых permission-кода (мёртвые вычищены — `permissions.ts`), анти-эскалация в канонической админке (`admin.routes.ts:161-167, 796-802, 1052-1056`), системные роли immutable, права читаются из БД per-request (мгновенный отзыв).
6. **Auth**: Telegram initData HMAC + timingSafeEqual + auth_date replay-защита (`src/auth/telegram.ts:28-44`), сессии HMAC 7д, requireAuth требует `status='active'` каждый запрос, dev-auth fail-closed (boot-fail при `production`+`ENABLE_DEV_AUTH=1` — `env.ts:35-37`).
7. **Audit + история**: `audit_logs` (old/new jsonb, source) транзакционно при каждом переходе/КП/складе/админ-действии; `request_status_history` на каждый переход; экран AuditLog в админке (`audit.view`).
8. **Admin-панель Mini App**: 9 вкладок (структура, люди, права, workflow-конструктор с guard'ами H1 и in-flight, материалы, формы-конструктор, настройки, аудит, обзор) — всё живое API, без моков.
9. **Env/deploy гигиена**: fail-fast секреты ≥16 симв., NODE_ENV fail-closed к production, seed-guard'ы от прода, nginx HSTS, backup с ротацией и sanity-check.
10. **Качество кода**: typecheck чистый, 175/175 тестов, ни одного мокнутого экрана во frontend, double-submit-локи, loading/empty/error почти везде.

---

## 4. What Is Partially Working

1. **Статусный движок** — статусы = step kinds (динамические), а не 35 статусов ТЗ: нет `submitted`, `reserved`, `quotation_received`, `waiting_payment`/`paid` (один `finance_payment`), `cancelled` (мёртвое значение — отмена пишется как `rejected`, `compat.routes.ts:461`).
2. **Procurement-lite** — КП и выбор поставщика с SoD и предупреждением о единственном КП (`lifecycle.service.ts:352-354`), но без RFQ/сравнения/аномалий/blacklist; КП можно привязать к деактивированному поставщику (`lifecycle.service.ts:318-319` — нет проверки `status='active'`).
3. **Уведомления** — создание заявки/этап/финал/reject уходят апруверам и автору через бота (`routes.ts:61-91, 598-609`), но: fire-and-forget без retry/персистенции (`bot.ts:78-84`), compat-слой не шлёт ничего, `requestMovedToStepMessage` — мёртвый код.
4. **Warehouse** — receive/issue образцовые, но `reservations`/`reservedQty` мертвы (`schema.ts:545, 585-597` — ни одной записи из кода), adjust/transfer/write_off — enum без кода (используются 2 из 9 movement types).
5. **Документы** — только вложения к заявкам: base64 в text-колонке (`schema.ts:660`), ≤2MB, без типов/версий/линковки к поставщикам/платежам.
6. **DNA/Audit** — состав полей соответствует ТЗ, но `deviceInfo`/`ipAddress` не заполняются, роль актёра не пишется (кроме snapshot-колонки, которую никто не пишет — `compat.routes.ts:249` читает всегда-null), иммутабельность не закреплена на уровне БД.
7. **Scope-гранулярность RBAC** — работает на lifecycle-действиях (`scopeCovers`, fail-closed), но чтение списков — holding-wide для любого носителя oversight-права (`routes.ts:26-32, 334-338`; осознанное решение M7, расходится с конструктором scope-назначений).
8. **Edit заявки** — гейт по статусу есть (`EDITABLE=['draft','pending_approval']`, `routes.ts:736-740`), но `pending_approval` — это каждый approval-шаг, т.е. на финальном директорском согласовании автор всё ещё меняет title/description/neededDate (items и суммы менять нельзя — и это правильно).

---

## 5. What Is Missing (полностью)

| Контур ТЗ | Детали |
|---|---|
| **Finance-модуль** | invoices, payment_requests, payments, partial payment, duplicate bank_reference, mismatch-детекция, финансовый экран. Есть только шаг `mark_paid` (PIN+SoD) без финансовой записи |
| **Budgeting** | budgets, budget_lines, budget check при создании, Budget vs Actual — ничего |
| **Documents/OCR** | document types, OCR pipeline, classify/extract/confirm, versioning, sign, create-invoice-from-document |
| **AI (14 модулей)** | AI pre-check, duplicate detection, supplier intelligence, anomaly, fraud, executive assistant — 0 |
| **Reports/Экспорт** | ни одного экспорта CSV/Excel, `reports.view` — permission без единого endpoint (`grep`: 0 использований) |
| **Notification Center** | таблицы notifications нет, in-app центра нет, колокольчик-иконка не используется (`icons.tsx:11`) |
| **Desktop Dashboard** | Sidebar (15 разделов), Topbar (global search, switchers, AI Ask, bell), UniversalTable (saved views, export, bulk, pinning), KPI cards (10 шт.), виджеты (10 шт.) |
| **Бот-диалоги** | /link с одноразовыми истекающими кодами, /profile, /status, /material, /upload, /ai, /cancel, FSM `telegram_sessions`, approve с PIN из чата |
| **Статусы/переходы** | draft→submit, reserve, cancelled как статус, changes_requested (возврат на доработку), delegate, add signer |
| **Прочее** | material_aliases, purchase_orders, request_comments (отдельная сущность), min/low-stock alerts, PO, supplier ratings-логика |

---

## 6. P0 Blockers

### P0-1. `scripts/reset-tenant.ts` уничтожает audit log и всех пользователей без production-guard
- **Файл:** `scripts/reset-tenant.ts:56, 88` (в т.ч. `tx.delete(schema.auditLogs)`), hardcoded owner TG `8236045489` (:11).
- **Актуально:** скрипт работает напрямую по `DATABASE_URL` из env; ни одной проверки NODE_ENV/подтверждения. Один запуск с прод-URL = невосстановимая потеря журнала accountability-системы + всех заявок.
- **Ожидаемо:** wipe-скрипты либо удалены из репо, либо fail-closed (требуют `FORCE_WIPE=1` + явное имя БД + отказ при `NODE_ENV=production`).
- **Fix:** guard в первой строке скрипта (как в `seed-pilot-cli.ts:13-18`), интерактивное подтверждение имени холдинга. То же для `scripts/clear-requests.ts` и `scripts/reset-roles.ts` (последний удаляет **системные роли всех тенантов** — `reset-roles.ts:30-41`).
- **Блокер для Mini App:** нет. **Блокер для прода:** да (операционный).

### P0-2. GitHub PAT открытым текстом в git remote URL
- **Где:** `git remote -v` → `https://tursunovbahtier:ghp_***@github.com/...`.
- **Актуально:** токен доступен любому с доступом к машине/копии `.git/config`; рекомендация из отчёта FIXES_REPORT_2026-07-02 не выполнена.
- **Fix:** ревокнуть токен на GitHub немедленно, перейти на credential helper / SSH-ключ.
- **Блокер для прода:** да (компрометация репозитория = компрометация supply chain).

*(В каноническом рантайм-коде P0 не найдено: auth/RBAC bypass отсутствует, деньги закрыты permission+PIN+SoD, склад атомарен.)*

---

## 7. P1 High Priority Issues

| ID | Модуль | Файл | Проблема | Expected | Fix |
|---|---|---|---|---|---|
| **P1-1** | Workflow/Finance | `src/workflow/engine.ts:51,68-70`, `src/services/request.service.ts:133` | **Обход amount-гейта самодекларацией цены.** `estimatedAmount` при создании = Σ(qty×unitPrice) от автора; frontend всегда шлёт `unitPrice:0` (`web/src/App.tsx:972`) → сумма 0 → threshold-шаги отфильтрованы при выборе первого шага. Guard H1 (`admin.routes.ts:176-200`) защищает только схемы С procurement-шагом (там сумма пересчитывается после `select_supplier`). В workflow без procurement пороговые согласования не сработают никогда | Порог должен опираться на верифицированную сумму (КП) или блокировать конфигурацию | Расширить H1-инвариант: threshold-шаг требует procurement-шаг раньше себя В ЛЮБОЙ схеме; либо запретить thresholdAmount в workflow без procurement |
| **P1-2** | Approvals (compat) | `src/http/compat.routes.ts:372-388` | **Approve без PIN для кастомных ролей через legacy API** (SERVE_DESIGN=1): PIN проверяется только для ролей `finance/director/owner`; для остальных подпись создаётся (`approval.service.ts:137-142`) с типом `telegram_pin` — фиктивная подпись в DNA | PIN на каждом approve (как в canonical `routes.ts:657-676`) | Требовать PIN всегда, либо вывести compat из эксплуатации |
| **P1-3** | RBAC (compat) | `compat.routes.ts:939-954, 1002-1059` | **Эскалация привилегий через compat /admin/users**: `canAssignRole` блокирует лишь owner/director/admin — носитель `users.manage` назначает роль `finance` (mark_paid) кому угодно, минуя scope-aware анти-эскалацию канона; `setSingleRole` hard-delete'ит все userRoles (уничтожение истории назначений) | Анти-эскалация как в `admin.routes.ts:796-802` | Переиспользовать канонические guard'ы или удалить compat-админку |
| **P1-4** | Finance (compat) | `compat.routes.ts:623-666` | **Смена суммы после согласований**: `PATCH /quotations/:id/select` блокирует только терминальные статусы — на пост-согласовательных шагах можно выбрать дорогое КП и перезаписать `estimatedAmount` после прохождения порогов | Выбор КП только на procurement-шаге (как canonical) | Гейт по текущему step kind |
| **P1-5** | Telegram bot | `src/bot/bot.ts` (весь, 84 строки) | Диалоговый слой ТЗ отсутствует: нет /link-кодов, /cancel, /status, /material, FSM-сессий, approve из чата. Реализовано 3 из 14 команд + лаунчер WebApp | Согласно ТЗ §19 | Продуктовое решение: либо реализовать conversations (grammY), либо официально сузить скоуп бота до «уведомления + Mini App» |
| **P1-6** | Notifications | `bot.ts:78-84`, `routes.ts:55-57` | Fire-and-forget без персистенции/retry: заблокированный бот/сбой сети = молчаливая потеря уведомления апруверу (только console.error). Критичный шаг может «зависнуть» незамеченным | Таблица notifications + статус доставки + retry | Персистентная очередь (таблица + воркер), бейдж в Mini App |
| **P1-7** | Frontend | `web/src/App.tsx:672-728` | **Поиск/фильтры «Заявки» работают только по загруженной странице** (серверная пагинация 30, фильтрация клиентская): при >30 заявок поиск «не находит» существующее, счётчик врёт | Серверный поиск/фильтр (query-параметры) | Пробросить search/status/date в `GET /api/requests` |
| **P1-8** | DB/Data safety | `schema.ts:442,461,479,588,609,655` | `ON DELETE CASCADE` от `requests` на approvals/history/quotations/attachments/reservations: один SQL-DELETE заявки уничтожает всю историю согласований | Для accountability: RESTRICT + archive-паттерн | Сменить FK на RESTRICT (миграция), удаление — только archive |

## 8. P2 Medium Issues

| ID | Модуль | Файл | Проблема |
|---|---|---|---|
| P2-1 | Lifecycle | `dashboard.service.ts:29-30`, `admin.routes.ts:28,144`, `compat.routes.ts:456` | **`closed` не в списках терминальных в 3 местах**: (а) dashboard вечно считает закрытые «активными»; (б) `workflowHasInFlight` вечно true → правка workflow блокируется навсегда после первой закрытой заявки; (в) закрытую заявку можно owner-override'ом переписать в approved/rejected |
| P2-2 | Security | `routes.ts:637-650`, `compat.routes.ts:402-415` | **Смена PIN без старого PIN/переаутентификации**: украденный Bearer (7 дней) позволяет переустановить PIN и подписывать деньги — PIN перестаёт быть вторым фактором |
| P2-3 | Security/Tenant | `routes.ts:825,855,799`, `compat.routes.ts:793,831` | Cross-tenant: `warehouse receive/issue` не валидируют `warehouseId` в холдинге; balances/stock join'ят materials/warehouses без holding-фильтра → запись в чужой склад/утеч