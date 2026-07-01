# Factory OS — Функциональное тестирование по ролям

**Дата:** 2026-07-02
**Метод:** статический анализ кода + прогон тестов (4 параллельных QA-агента, независимая перепроверка ключевых находок).
**Модель:** Claude Opus 4.8 (1M).
**Прод не затрагивался** — весь анализ на локальной копии.

---

## Итог по тестам (baseline)

| Проверка | Результат |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm test` (полный) | ✅ **27 файлов, 161 тест — все passed** (~212 s) |
| E2E (golden-path, warehouse-lifecycle, procurement-lite) | ✅ 16/16 passed |

Зелёная база тестов, но покрытие имеет дыры — основные находки лежат в непокрытых путях.

---

## Архитектурный контекст (важно для интерпретации severity)

- **Два параллельных API-слоя.** Канонический `src/http/routes.ts` (гранулярный RBAC) — активен по умолчанию. Легаси `src/http/compat.routes.ts` — только при `SERVE_DESIGN=1` (в `.env` и `.env.example` стоит `0`, opt-in).
- **Две ветки продвижения заявки.** `performAction` (`/requests/:id/action`, использует текущий Mini App) и `approveApproval` (`/approvals/:id/approve`, живой эндпоинт, UI им не пользуется). Они разошлись — легаси-ветка сломана (см. C1).

---

## Сводная таблица находок

| ID | Severity | Область | Файл:строка | Проблема |
|---|---|---|---|---|
| **C1** | **CRITICAL** | backend logic | `approval.service.ts:150-158` | `approveApproval` всегда ставит `pending_approval` и вставляет approval на следующий шаг независимо от его `stepKind` → orphan pending → заявка застревает навсегда. |
| **H1** | HIGH (конфиг) | backend logic | `engine.ts:63-72`, `lifecycle.service.ts:394` | Роутинг только «вперёд по stepOrder»: threshold-approval раньше шага КП молча пропускается при росте суммы (обход финконтроля). Дефолтный сид безопасен. |
| **H2** | HIGH | frontend | `web/src/App.tsx:275-277` | `else if`-цепочка в BottomNav: роль admin+warehouse.view не видит Склад; при warehouse+procurement виден только Склад. Блокировка функционала. |
| **H3** | HIGH→MEDIUM | RBAC (legacy) | `legacy-auth.ts:92`, `compat.routes.ts` | Compat-API гейтит склад/закупки по строке роли через усечённый `ROLE_PRIORITY` (8/18): 10 ролей заблокированы, director/admin ошибочно проходят. Только при `SERVE_DESIGN=1` (по умолчанию off). |
| **M1** | MEDIUM | frontend | `web/src/Warehouse.tsx:110`, `App.tsx:251` | Формы Приёмка/Выдача видны всем с `warehouse.view` (права не передаются в экран). «Только просмотр» жмёт кнопку → 403. |
| **M2** | MEDIUM | backend integrity | `warehouse.service.ts:73`, `lifecycle.service.ts:413` | Ключ идемпотентности `(requestId, materialId, movementType)` без привязки к шагу → 2-й receiving/issue того же материала = тихий no-op. Частичные поставки молча невозможны. |
| **M3** | MEDIUM | backend integrity | `lifecycle.service.ts:419` | Позиции без `materialId` молча пропускаются: заявка из custom-позиций доходит до `issue`→`closed`, склад не тронут, без warning. |
| **M4** | MEDIUM | backend logic | `lifecycle.service.ts:255,178` | Separation of duties только для `approve`. Заявитель с ролью finance/warehouse сам делает `mark_paid`/`wh_in_stock`/`select_supplier`/`issue` по своей заявке. |
| **M5** | MEDIUM | RBAC | `permissions.ts`, `system-roles.ts` | Мёртвые права: `finance.approve_payment`, `procurement.manage`, `settings.view`, `audit.export`, `approvals.override`, `warehouse.reserve/adjust`, `requests.comment`, `reports.view`. Каталог ≠ enforcement. |
| **M6** | MEDIUM | backend logic | `approval.service.ts:104` | Нет `FOR UPDATE` (в `performAction` есть, стр. 243). Параллельный double-approve через легаси → `23505`→HTTP 500 вместо чистого 409. |
| **M7** | MEDIUM | RBAC | `routes.ts:769,798…`, `rbac.ts:33` | Прямые эндпоинты проверяют право только в holding-scope: роль на уровне фабрики/отдела не может пользоваться `/warehouse/receive`, `/suppliers`, `/procurement/queue` (fail-closed 403). |
| **M8** | MEDIUM | RBAC (design) | `system-roles.ts:74` | Склад держит `approvals.approve/reject` — может отклонять заявки на шагах, где он handler. Подтвердить осознанность. |
| **M3b** | MED/LOW | frontend | `App.tsx:796,1502` | Скрытие сумм/КП только на клиенте (`canSeeProcurement`), `estimatedAmount` в payload `/requests`. Проверить фильтрацию на бэке. |
| **L2** | LOW | backend logic | `lifecycle.service.ts:353` | Если pending-approval отсутствует, `approve` всё равно продвигает заявку без signature («согласовано» без подписи). |
| **L3** | LOW | backend logic | `lifecycle.service.ts:401` | Терминал `closed` только если последний шаг kind `close`; workflow с концом на `issue` остаётся `approved`. |
| **L4** | LOW | backend logic | `lifecycle.service.ts:326` | `add_quotation` переписывает `estimatedAmount` суммой последнего КП до выбора поставщика. |
| **L5** | LOW | frontend | `App.tsx:248,1511` | «← Назад» всегда → `list` (требует `requests.view`): согласующий без права теряет контекст. |
| **L6** | LOW | frontend | `App.tsx:1691` | Для `action.amount` проходит `>= 0` (ноль), для `quote='add'` требуется `> 0` — несогласованность. |
| **L8** | LOW | RBAC | `routes.ts:177` | `GET /config` без проверки права отдаёт любому члену холдинга всю оргструктуру + id/ФИО сотрудников. |
| **L9** | LOW | frontend | `web/src/screens/Menu.tsx` | Мёртвый дубликат `Menu` (используется inline в App.tsx). |
| **L10** | LOW | backend integrity | `lifecycle.service.ts:188` | Нет детекции «застрявшей» заявки; warehouse_check→«в наличии», когда остаток шагов gated `{inStock:false}` → авто-`approved` минуя `issue`. |

---

## Часть 1. Backend — бизнес-логика workflow

### C1 (CRITICAL, подтверждено) — легаси-ветка согласования брикует заявку
`src/services/approval.service.ts:150-158`. `approveApproval` всегда пишет `status='pending_approval'` и вставляет `approvals` на следующий шаг **независимо от его типа**. Если следующий шаг не `approval` (`warehouse_check`/`procurement`/…):
1. Статус заявки неверен (`pending_approval` вместо реального kind);
2. На неаппрувном шаге повисает orphan `approvals {status:pending}`, который `performAction` никогда не резолвит (блок approvals только для kind `approval`, стр. 353);
3. При достижении реального approval-шага вставка нового pending нарушит уникальный индекс `approvals_one_pending_idx` → `23505` → **заявка застревает навсегда**.

Эндпоинт `POST /api/approvals/:id/approve` живой (`routes.ts:640`, метод есть в `web/src/api.ts`). Mini App его не вызывает, но доступен любому API-клиенту.
**Fix:** привести `approveApproval` к логике `performAction` — `statusForStep(next)` + вставка approval только для kind `approval` (как `enterApprovalIfNeeded`); либо снять эндпоинт с роутинга.

Прочие: H1, M4, M6, L2, L3, L4 — см. сводную таблицу.

## Часть 2. Доступ ролей (RBAC)

Гранулярный слой (`routes.ts`/`admin.routes.ts`) корректен: default-deny, scope-aware fail-closed, owner=all, admin не авто-апрувер, согласование гейтится ролью шага, запрет self-approval, мультитенантность без межхолдинговых дыр.

Вердикт по ролям — спорные: **warehouse** (`approvals.approve/reject` + мёртвые reserve/adjust), **requester** (`requests.comment` без эндпоинта), **observer** (`/requests` пусто — нет в OVERSIGHT), **auditor** (`audit.export` не проверяется). Остальные 14 — OK.

Находки: H3, M5, M7, M8, L8 — см. сводную таблицу.

## Часть 3. Frontend — UI по ролям

Сильная сторона: действия по заявке **backend-driven** (`req.actions`/`availableActions`), поля PIN/comment/amount/quote по флагам действия; двойная защита Inbox; единообразная обработка 401/таймаутов; защита от двойной отправки; валидация форм; per-tab гейтинг админки.

Находки: H2, M1, M3b, L5, L6, L9 — см. сводную таблицу.

## Часть 4. End-to-end жизненный цикл заявки

Карта: Создание(requester) → approval → warehouse_check → procurement → finance_payment → delivery → receiving → issue → close.

Инварианты подтверждены: согласованность `status`↔`currentStepId` (состояние «approved & step≠null» невозможно), history+audit на каждом переходе, склад — единый fail-loud путь с полным откатом при нехватке остатка, estimatedAmount фиксируется при выборе КП.

Пробелы покрытия тестами: `receive_goods` (income через lifecycle), `mark_arrived` (delivery), полная 8-звенная цепочка, и все 4 сценария части 1 (C1, H1, M4, M6).

Находки: M2, M3, L10 — см. сводную таблицу.

---

## Приоритеты на исправление

1. **C1** — легаси `approveApproval` брикует заявку → привести к `performAction` или снять эндпоинт. **Сначала это.**
2. **H2** — Склад/Закупки недоступны совмещённым ролям → заменить `else if`-цепочку на независимые пункты.
3. **H1** — обход финконтроля при перестановке шагов → валидация конструктора.
4. **M1–M8** — мёртвые права, права в Warehouse-экран, решение по SoD/склад-approvals, идемпотентность с привязкой к шагу.

## Что реализовано правильно

Чистый data-driven роутинг · транзакции с `FOR UPDATE` в основном пути · склад идемпотентен и fail-loud с полным откатом · SoD на approve и inStock-ветвление (покрыты тестами) · scope-aware fail-closed RBAC без межхолдинговых дыр · backend-driven действия в UI · валидация форм и обработка ошибок · fail-safe `draft` при отсутствии workflow.
