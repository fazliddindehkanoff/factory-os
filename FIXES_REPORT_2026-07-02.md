# Factory OS — Отчёт об исправлениях (Fable 5), 2026-07-02

Продолжение цикла: Фаза 1 (архитектура+baseline) → Фаза 2 (4 направления тестирования, `PHASE2_FUNCTIONAL_TEST_FABLE_2026-07-02.md`) → Фаза 3 (верификация 20 находок Opus — все подтверждены, `PHASE3_VERIFICATION_FABLE_2026-07-02.md`) → **Фаза 4 (эта)**.
Предыдущий отчёт Opus 4.6 сохранён как `FIXES_REPORT_2026-07-02_opus46.md`.

## Итоговый статус

| Проверка | До | После |
|---|---|---|
| `npm run typecheck` | ✅ | ✅ |
| `npm test` | ✅ 27 файлов / 161 тест | ✅ **31 файл / 175 тестов** |
| `cd web && npm run build` | ✅ | ✅ (340.8 kB, gzip 93.2 kB) |

## Что исправлено (по ID)

### CRITICAL / HIGH

| ID | Файл | Исправление |
|---|---|---|
| **C1** | `src/services/approval.service.ts` | `approveApproval` приведён к логике `performAction`: статус = `statusForStep(next)`, approval-строка вставляется **только** для kind `approval`. Эндпоинт сохранён (живой контракт compat-слоя), решение обосновано: снятие сломало бы `SERVE_DESIGN=1` и покрытые security-тесты |
| **B2** (новая, HIGH) | `approval.service.ts` | Fail-closed: approval/reject по заявке с `currentStepId=null` → 409. Orphan pending больше не может переоткрыть закрытую заявку или перевести `approved`→`rejected` |
| **M6** | `approval.service.ts` | `FOR UPDATE` на строке заявки + повторное чтение approval после блокировки: конкурентный double-approve теперь чистый 409, а не 23505→500 с дублем подписи |
| **H1** | `src/http/admin.routes.ts` | `assertThresholdsAfterProcurement`: конструктор отклоняет (400, с откатом транзакции) схему, где approval-шаг с `thresholdAmount`/`amountGte` стоит раньше procurement-шага. Проверка на POST/PUT/reorder шагов |
| **H2 (F1)** | `web/src/App.tsx` | BottomNav: else-if заменена на независимые табы — Админ, Склад (`warehouse.view`), Закупки (`procurement.view`) видны параллельно |
| **E2** (новая, HIGH) | `src/services/warehouse.service.ts`, `drizzle/0010` | Ключ идемпотентности учитывает складской пул: ручная приёмка в именованный склад больше не блокирует lifecycle-income в NULL-пул → `issue` не застревает |

### MEDIUM

| ID | Файл | Исправление |
|---|---|---|
| **M2** | `warehouse.service.ts`, `schema.ts`, `drizzle/0010_spooky_photon.sql` | Новая колонка `stock_movements.workflow_step_id` + переработанный ключ идемпотентности: retry шага — no-op; **два разных receiving/issue шага двигают склад каждый**; ручная операция считается дублем lifecycle-операции того же пула (сохранён прежний контракт pilot-теста) |
| **M3** | `lifecycle.service.ts` | Позиции без `materialId`/с qty≤0 на receiving/issue теперь дают явный `warning` в ответе |
| **M4** | `step-kinds.ts`, `lifecycle.service.ts` | SoD расширен флагом `sod: true` на money/routing-действия: `mark_paid`, `select_supplier`, `wh_in_stock`, `wh_out_of_stock` — нельзя по собственной заявке. Операционные `mark_arrived`/`receive_goods`/`issue` сознательно исключены (физические акты; финконтроль к этому моменту уже пройден другими) |
| **M5** | `rbac/permissions.ts`, `system-roles.ts` | Удалены 7 мёртвых прав (`requests.comment`, `warehouse.reserve`, `warehouse.adjust`, `procurement.manage`, `finance.approve_payment`, `settings.view`, `audit.export`) + вычищены из ролей и UI-констант. `approvals.override` **заработал** (гейт compat-override), `users.view` **заработал** (чтение списка пользователей), `reports.view` оставлен (живой UI-гейтинг дашборда). Каталог 33→26 |
| **M7 (R5)** | `rbac/rbac.ts`, `routes.ts` | Новый `hasPermissionInHolding` для модульных эндпоинтов (16 проверок): назначение роли, суженное до фабрики/отдела, больше не даёт 403 на списках/создании. Объектные проверки (lifecycle) по-прежнему строго scope-aware |
| **M3b (F3)** | `routes.ts` | КП (`quotations`) отдаются в `GET /requests/:id` только при `procurement.view`/`finance.view`/`audit.view` — серверное зеркало клиентского `canSeeProcurement` |
| **B9** (новая) | `step-kinds.ts`, `lifecycle.service.ts` | `close` — `requesterOnly`: подтвердить получение может только автор заявки, а не любой обладатель `requests.create` |
| **B8** (новая) | `warehouse.service.ts` | Гонка первого прихода: 23505 от `stock_balances_uniq` (индекс уже был в миграции 0009) теперь перехватывается ретраем вместо 500 |
| **R6** (новая) | `admin.routes.ts` | `assertActorOutranks`: архивировать пользователя / отзывать роли можно только у того, чьи права ты сам держишь — admin больше не может «обезглавить» owner'а |
| **M1 (F2)** | `web/src/screens/Warehouse.tsx`, `App.tsx` | Вкладки Приёмка/Выдача гейтятся `warehouse.receive`/`warehouse.issue` |
| **F4** (новая) | `web/src/App.tsx`, `screens/shared.tsx` | Один источник statusMeta/progressOf (полный набор статусов, включая receiving/issue/delivery/finance_payment) |
| **E5** (новая) | `compat.routes.ts` | Легаси-переходы пишут history (override, receive-close) и audit (add/select КП) |
| **R1/R2/R3** (новые) | `compat.routes.ts` | `/warehouse/stock` — гейт warehouse.view (плюс штатные роли дизайна); compat approve/reject — permission-гейты как в canonical |

### LOW

| ID | Исправление |
|---|---|
| **L2** | Approve без pending-строки теперь создаёт резолвнутую approval-запись + signature (никаких «согласовано без следа») |
| **L3** | Цепочка, оканчивающаяся на `issue`, терминируется как `closed` (физическая выдача состоялась), не `approved` |
| **L4** | `add_quotation` не переписывает `estimatedAmount`; сумма фиксируется только `select_supplier` |
| **B10/E9** | Черновик без workflow даёт честное сообщение вместо «Заявка уже завершена» |
| **R10** | `GET /admin/users` — `users.view` или `users.manage` |
| **L8 (R7)** | `/config` отдаёт список сотрудников только обладателям `requests.create` (нужен форме создания) |
| **F5** | Убрано задвоенное поле «Сумма КП» в модалке |
| **F9** | Фильтр статусов списка дополнен workflow-статусами |
| **L6 (F6)** | `amount > 0` единообразно |
| **L5 (F7)** | «Назад» из деталей возвращает на экран-источник |
| **F11** | qty=0 — ошибка валидации вместо тихой подмены на 1 |
| **L9 (F8)** | Удалён мёртвый `screens/Menu.tsx`; дубликаты statusMeta ликвидированы |
| **E12** | Ложно-зелёный тест `approvals-security` усилен проверкой состояния заявки |

## Добавленные тесты (14 новых; функциональные — падали ДО фикса)

| Файл | Что закрывает |
|---|---|
| `src/services/approval-branch-sync.test.ts` (3) | **C1** (статус по kind следующего шага; полная цепочка без нарушения `approvals_one_pending_idx`) + **B2** (терминальная заявка → 409). До фикса падали 3/3 — воспроизведение зафиксировано в Фазе 3 |
| `src/services/lifecycle-fixes.test.ts` (7) | **M4** (SoD mark_paid свой/чужой), **B9** (close чужой заявки), **L4**, **L3+M3** (issue-конец = closed + warning), **M2** (два receiving-шага двигают склад дважды, retry — no-op, ручная после lifecycle — дедуп), **M7** (factory-scoped requester: list+create 200) |
| `src/services/full-chain-e2e.test.ts` (1) | Полная 8-звенная out-of-stock цепочка: `mark_arrived` и `receive_goods` исполняются впервые; инварианты: history=10, приход=1, баланс=0, pending=0 |
| `src/http/workflow-validation.test.ts` (3) | **H1**: threshold до procurement → 400; после → 201; reorder с нарушением → 400 + откат |
| `src/http/approvals-security.test.ts` (усилен) | **E12**: happy-path теперь проверяет статус/отсутствие orphan |
| `src/rbac/rbac.test.ts` (обновлён) | Пины размера каталога 33→26 (осознанное удаление мёртвых прав) |

## Миграция БД

`drizzle/0010_spooky_photon.sql`:
1. `stock_movements` + колонка `workflow_step_id` (FK на `workflow_steps`).
2. Пересоздан `stock_movements_idem_idx`: уникальность по (request, material, type, COALESCE(step), COALESCE(warehouse)).

**На проде обязательно выполнить `npm run db:migrate` до рестарта сервиса.** Миграция аддитивная и безопасная (существующие строки получают `workflow_step_id = NULL` — семантика «ручная операция», что соответствует истории).

## Сознательно оставлено как есть (с обоснованием)

| ID | Причина |
|---|---|
| **R8** (observer видит только свои заявки) | Существующий контракт закреплён тестом `request-visibility` («observer не читает чужую заявку»). Расширение видимости observer — продуктовое решение владельца. Если нужно — добавить `reports.view` в `OVERSIGHT_PERMS` (routes.ts:23) и обновить тест |
| **M8** (warehouse держит `approvals.approve`) | `approvals.reject` складу необходим по конструкции (reject на warehouse_check-шаге). `approvals.approve` оставлен: нужен, если конструктор назначает склад согласующим. Убирается одной строкой в system-roles.ts при желании |
| **R9** (dept_head видит все заявки холдинга) | Фильтрации по отделу нет нигде в системе — осознанная текущая модель видимости |
| **E6** (compat: PIN только для money-стадий) | Контракт легаси-дизайна (его UI показывает PIN-модалку только там). Canonical-слой требует PIN всегда; SERVE_DESIGN=0 по умолчанию |
| **R4/H3** (усечённый ROLE_PRIORITY в compat) | Легаси-дизайн знает только 8 ролей — расширенные роли не входят в его контракт; canonical-слой обслуживает все 18. Права-гейты (R1-R3) добавлены; ролевые списки не расширялись |
| **B14/L10** (pilot: wh_out_of_stock → тупик на issue) | Отсутствие procurement в pilot — задокументированное решение пилота (комментарий в seed-pilot.ts) |
| **E10** (`isRequired` мёртвое поле) | Зарезервированное поле схемы; удаление = лишняя миграция без пользы |
| **B16** (fromStatus читается до транзакции) | Влияет только на текст уведомления в гонке; данных не касается |
| **F12** (hardcoded `cf_urgency`) | Ограничение конструктора форм; требует продуктового решения |
| Частичные поставки (остаток M2) | Реализована шаговая гранулярность; накопительный учёт количества одной позиции — отдельная фича с UI |

## Изменённые файлы

**Backend:** `src/services/{approval,lifecycle,warehouse}.service.ts`, `src/workflow/step-kinds.ts`, `src/rbac/{rbac,permissions,system-roles}.ts`, `src/http/{routes,admin.routes,compat.routes}.ts`, `src/db/schema.ts`, `drizzle/0010_spooky_photon.sql` (+meta).
**Frontend:** `web/src/App.tsx`, `web/src/screens/{Warehouse,shared}.tsx`, удалён `web/src/screens/Menu.tsx`.
**Тесты:** 4 новых файла + 3 обновлённых.
**Отчёты:** `PHASE2_FUNCTIONAL_TEST_FABLE_2026-07-02.md`, `PHASE3_VERIFICATION_FABLE_2026-07-02.md`, этот файл.

## Что ещё стоит сделать (рекомендации, не блокеры)

1. **Секрет в git remote**: URL origin содержит GitHub PAT прямым текстом — перейти на credential helper и **ревокнуть текущий токен**.
2. Решение владельца по R8 (observer) и M8 (`approvals.approve` у склада).
3. Частичные поставки: накопительный учёт количества по позиции.
4. Вернуть с реализацией удалённые фичи-права: комментарии (`requests.comment`), резервирование (`warehouse.reserve` — таблица reservations уже есть), экспорт аудита (`audit.export`).
5. UI-экран «Финансы» для accountant/finance_manager.
6. Scope-aware видимость списков (фильтр по фабрике/отделу) — сейчас бинарная (свои / весь холдинг).
7. План вывода легаси-слоя (`SERVE_DESIGN=1`) из эксплуатации: остаточные риски (E6, R4) живут там.
