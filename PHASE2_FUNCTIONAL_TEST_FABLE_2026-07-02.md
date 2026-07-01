# Factory OS — Фаза 2: функциональное тестирование по ролям (Fable 5)

**Дата:** 2026-07-02 · **Метод:** 4 параллельных под-агента (backend-логика / RBAC / frontend / e2e) + baseline-прогон · **Прод не затрагивался.**

Baseline: typecheck ✅ · npm test ✅ 27 файлов / 161 тест (181.8 s) · web build ✅ · e2e (golden-path, warehouse-lifecycle, procurement-lite) ✅ 16/16.

---

## Сводная таблица находок (дедуплицировано по 4 направлениям)

Соответствие отчёту Opus 4.8 указано в скобках. Новые находки помечены **NEW**.

| ID | Severity | Файл:строка | Описание | Воспроизведение | Ожидалось vs Фактически |
|---|---|---|---|---|---|
| **B1** (=C1) | **CRITICAL** | `approval.service.ts:150-158` | `approveApproval` при продвижении безусловно ставит `status='pending_approval'` и вставляет `approvals{pending}` на следующий шаг любого kind → orphan pending; при следующем approval-шаге `enterApprovalIfNeeded` нарушает `approvals_one_pending_idx` → 23505 → 500, заявка застревает навсегда | POST `/api/approvals/:id/approve` на шаге 1 дефолтного tenant-workflow (шаг 2 = warehouse_check), затем `wh_in_stock` → 500 на каждом ретрае | `statusForStep(next)` + approval только для kind `approval` vs безусловные значения |
| **B2** **NEW** | **HIGH** | `approval.service.ts:82` | Guard «этап уже не активен» пропускается при `currentStepId=null`: orphan pending (из B1) на завершённой заявке можно approve → терминальная заявка **переоткрывается** (`pending_approval` + currentStepId), или reject → `approved`→`rejected` с перезаписью `closedAt` | Orphan через B1 при сумме < порогов, дождаться закрытия, POST approve/reject по orphan id | 409 для терминальной заявки vs тихая обработка |
| **E2** **NEW** | **HIGH** | `warehouse.service.ts:73-86`, `lifecycle.service.ts:424-436`, `routes.ts:795-823` | Рассинхрон складских пулов: lifecycle работает только с пулом `warehouseId=NULL`, а `/warehouse/receive` принимает `warehouseId`; ключ идемпотентности не учитывает склад. Ручная приёмка в склад W с requestId → lifecycle `receive_goods` = no-op → NULL-пул пуст → `issue` навсегда падает «Недостаточно остатка», хотя товар принят. Без requestId — двойной учёт | Ветка out-of-stock: POST `/warehouse/receive {warehouseId, requestId}` → `receive_goods` (no-op) → `issue` → ValidationError | Единый пул или ключ с учётом склада vs движение и баланс в разных пулах |
| **B3** (=H1) | HIGH (конфиг) | `engine.ts:63-72`, `lifecycle.service.ts:376-395`, `admin.routes.ts:1188-1260` | Роутинг только вперёд по stepOrder; конструктор не запрещает threshold-approval раньше procurement → рост суммы при выборе КП обходит финконтроль. Дефолтный сид безопасен (approvals на orders 4-6 после procurement 3). Смягчение: конструктор блокирует правки при in-flight заявках | Workflow: approval(threshold 5M, o.1) → procurement(o.2) → close; заявка 1M → шаг 1 неприменим; КП 50M select → close без согласования | Валидация конструктора vs обход возможен |
| **F1** (=H2) | HIGH | `web/src/App.tsx:275-277` | `else if`-цепочка BottomNav: Админ вытесняет Склад/Закупки, Склад вытесняет Закупки; альтернативного пути к экранам нет. operations_lead не видит ни Склад, ни Закупки | Роль admin-права+warehouse.view → нет таба Склад | Независимые табы по правам vs экраны недостижимы |
| **R4** (=H3) | HIGH → только SERVE_DESIGN=1 | `legacy-auth.ts:92-105`, `compat.routes.ts:544,589,767,794` | `ROLE_PRIORITY` — 8 кодов из 18: 10 ролей заблокированы в compat-гейтах (quotations, select, warehouse/receive, receive-close); admin/director наоборот получают складские/закупочные действия без warehouse.*/procurement.* прав. Подтверждено: `SERVE_DESIGN` по умолчанию `0` (env.ts:29-33 требует явного значения вне development, `.env.example`=0, index.ts: `==='1'`) | SERVE_DESIGN=1: procurement_head → POST quotations → 403; director → POST /warehouse/receive → 200 | Гейт по гранулярным правам vs усечённый список ролей |
| **B9** **NEW** | MEDIUM | `lifecycle.service.ts:148-152` | `approverRoleId` шага проверяется только для kind `approval`: роли, настроенные для warehouse_check/procurement/finance_payment/… шагов, декоративны — гейт только permission. Частный случай: `close` (perm `requests.create`) — любой пользователь холдинга с правом создания заявок может закрыть **чужую** заявку | Requester B: POST `/requests/:idA/action {action:'close'}` на шаге close заявки A | Роль шага уважается везде vs только для approval |
| **B8** **NEW** | MEDIUM | `warehouse.service.ts:42-52`, `schema.ts:548` | Нет уникального индекса на `stock_balances(holding, material, warehouse)`; `SELECT FOR UPDATE` не блокирует несуществующие строки → два конкурентных первых прихода создают две строки баланса → расщепление остатков | Два параллельных POST `/warehouse/receive` нового материала | uniqueIndex + upsert vs гонка первой вставки |
| **B4** (=M4) | MEDIUM | `lifecycle.service.ts:181,198,255-257` | SoD только для `approve`: заявитель с ролью finance/warehouse/procurement сам делает `mark_paid`/`wh_in_stock`/`select_supplier`/`receive_goods`/`issue` по своей заявке | requester+finance создаёт заявку и сам отмечает оплату | SoD на money/stock-действия vs только approve |
| **B5** (=M2, =E3) | MEDIUM | `warehouse.service.ts:73-86`, `lifecycle.service.ts:413-436` | Ключ идемпотентности `(requestId, materialId, movementType)` без шага/склада: второй income/outcome — тихий no-op, а шаг продвигается. Частичные поставки невозможны | Два receiving-шага в workflow или ручной receive с requestId до lifecycle-шага | Идемпотентность на (шаг, материал) или ошибка vs no-op + продвижение |
| **B6** (=M3, =E4) | MEDIUM | `lifecycle.service.ts:417-423` | Позиции без `materialId` и qty≤0 молча пропускаются: material-заявка из custom-позиций проходит receiving→issue→close с нулевым движением склада, без warning | Заявка items без materialId → полный цикл | Warning/блокировка vs тишина |
| **B7** (=M6) | MEDIUM | `approval.service.ts:104-121` | Нет `FOR UPDATE` (в performAction есть, lifecycle:243): конкурентный double-approve → две signatures + 23505 → 500 вместо 409 | Два параллельных POST approve одной approval | 409 «уже обработана» vs 500 + дубль подписи |
| **R5** (=M7 расшир.) | MEDIUM | `routes.ts:319,356,646,683,769,798,828,858,921,1054`, `rbac.ts:28-36` | Все прямые эндпоинты проверяют право с target `{holdingId}`: назначение роли, суженное до factory/department (доступно в админке), НЕ покрывает такой target → 403 даже на `requests.view`/`requests.create` — фича скоупов ломает базовый доступ | Назначить requester с departmentId → POST /requests → 403 | Право на своё подразделение работает vs fail-closed 403 на всё кроме lifecycle-действий |
| **R6** **NEW** | MEDIUM | `admin.routes.ts:653-682,790-861` | Анти-эскалация покрывает выдачу ролей, но не отзыв/архив: обладатель `users.manage` может заархивировать owner'а или отозвать его роль — «обезглавливание» тенанта | admin → DELETE /admin/users/{ownerId} → 200 | Нельзя трогать носителя более широких прав vs можно |
| **M5** (подтв., уточн.) | MEDIUM | `permissions.ts`, `system-roles.ts` | 10 мёртвых прав из 35 (grep-доказательство): `finance.approve_payment`, `procurement.manage`, `settings.view`, `audit.export`, `approvals.override` (backend), `warehouse.reserve`, `warehouse.adjust`, `requests.comment`, `reports.view` (backend), `users.view` (canonical) | grep по src/ | Каталог = enforcement vs каталог ≠ enforcement |
| **M8** (подтв.) | MEDIUM (спорно) | `system-roles.ts:74-84` | Роль warehouse держит `approvals.approve/reject` — может быть согласующим на approval-шагах со своей ролью + отклонять на шагах, где handler. Требует решения владельца | — | Подтвердить осознанность |
| **F2** (=M1) | MEDIUM | `web/src/screens/Warehouse.tsx:36-41,149-152`, `App.tsx:251` | Экран Склад не получает permissions: вкладки Приёмка/Выдача видны при только `warehouse.view` → 403 после отправки | warehouse.view-only → Склад → Приёмка → submit | Скрыть формы без receive/issue vs форма видна, 403 |
| **F3** (=M3b, подтв.) | MEDIUM | `App.tsx:668,796,1502-1503` ↔ `routes.ts:334-343,517-521` | Бэкенд не фильтрует `estimatedAmount`/`quotations` по правам — скрытие только клиентское; requester видит все КП своей заявки в JSON | devtools → GET /requests/:id | Серверная фильтрация vs полный payload (смягчение: видимость own-or-oversight) |
| **F4** **NEW** | MEDIUM | `App.tsx:1869-1944` vs `screens/shared.tsx:90-114` | Разошедшиеся копии statusMeta/progressOf: в App.tsx нет статусов `finance_payment`/`delivery`/`receiving`/`issue` → StatusPill показывает сырой код, прогресс падает на default | Заявка на шаге receiving → список/шапка | «Приёмка» vs `receiving` |
| **E5** **NEW** | MEDIUM (compat) | `compat.routes.ts:453-477,814-829,567-583,607-611` | Легаси-переходы без целостной записи: override и receive-close не пишут `request_status_history`; compat add/select quotation — ни audit, ни history | SERVE_DESIGN=1 | history+audit на каждый переход vs дыры |
| **E6/B15/R2** **NEW** (compat) | MEDIUM | `compat.routes.ts:358-393` | Compat-approve: PIN только для стадий finance/director/owner, право `approvals.approve` не проверяется, но signature `telegram_pin` пишется всегда → «подпись PIN» без ввода PIN | SERVE_DESIGN=1, approve шага dept_head без PIN | Подпись только после PIN vs подпись без PIN |
| **R1** **NEW** (compat) | MEDIUM | `compat.routes.ts:715-761` | `GET /warehouse/stock` без проверки прав — весь остаток склада виден любому активному пользователю холдинга | SERVE_DESIGN=1, requester → GET | `warehouse.view` vs открыт всем |
| **B10** (=E9, M12-фейлсейф) | MEDIUM/LOW | `request.service.ts:147-153`, `lifecycle.service.ts:247` | Draft-заявка (нет workflow) — невосстановимый тупик; performAction отвечает вводящим в заблуждение «Заявка уже завершена» | Заявка в холдинге без workflow | Механизм re-route/честная ошибка vs вечный draft |
| **B11** (=L2, =E7) | LOW | `lifecycle.service.ts:353-373` | Approve при отсутствующем pending продвигает шаг без approval-записи и без signature | Смена kind шага после создания заявки → approve | fail-closed vs «согласовано» без подписи |
| **B12** (=L3, =E8) | LOW | `lifecycle.service.ts:401` | `closed` только если последний шаг kind `close`; цепочка на `issue` остаётся `approved` (с closedAt) | Workflow …→issue | closed vs approved |
| **B13** (=L4) | LOW | `lifecycle.service.ts:290,326` | Каждый `add_quotation` перезаписывает `estimatedAmount` до выбора поставщика | КП 100M, затем КП 1M — сумма скачет | Фиксация на select vs на каждый add |
| **B14** (=L10, =E11) | LOW (конфиг) | `seed-pilot.ts:52-57`, `lifecycle.service.ts:394-404` | Pilot без procurement-ветки: `wh_out_of_stock` → issue → «Недостаточно остатка» → тупик (только reject). Общий случай: wh_in_stock при остатке шагов {inStock:false} → авто-approved мимо issue | Pilot-сид: wh_out_of_stock → issue | Маршрут out-of-stock vs тупик |
| **F7** (=L5) | LOW | `App.tsx:248,1511-1513` | «Назад» из деталей всегда → list (требует requests.view); все 18 системных ролей право имеют — касается только кастомных | Кастомная роль без requests.view | Возврат к источнику vs 403 |
| **F6** (=L6) | LOW | `App.tsx:1691` | `amount >= 0` vs `> 0` для quote add — несогласованность (путь сейчас мёртвый) | — | Единообразно >0 |
| **R7** (=L8) | LOW | `routes.ts:177-255` | GET /config без права: оргструктура + id/ФИО всех активных сотрудников любому члену холдинга | Любая роль → GET /config | Гейт/урезание vs полный список |
| **F8** (=L9 расшир.) | LOW | `web/src/screens/Menu.tsx`, `screens/shared.tsx` | Menu.tsx — мёртвый код (0 импортов); shared.tsx дублирует statusMeta/progressOf — источник F4 | grep | Один источник правды vs две копии |
| **R8** **NEW** | LOW | `routes.ts:23,328` | OVERSIGHT_PERMS без `reports.view` → observer в canonical видит пустой список заявок (роль нефункциональна); auditor видит аудит, но не заявки холдинга | observer → GET /requests → пусто | Наблюдатель read-only видит заявки vs пусто |
| **R9** **NEW** | LOW (спорно) | `routes.ts:23` | dept_head через `approvals.view` видит все заявки холдинга — нет фильтра по отделу | — | Подтвердить осознанность |
| **R3** **NEW** (compat) | LOW | `compat.routes.ts:486-495` | Compat-reject без проверки права на роуте (только роль шага в сервисе) | SERVE_DESIGN=1 | Рассинхрон с canonical |
| **R10** **NEW** | LOW | `admin.routes.ts:551` vs `compat.routes.ts:901` | `users.view` мёртв в canonical (везде users.manage) | grep | — |
| **E10** **NEW** | LOW | `engine.ts:47-55`, `schema.ts:366` | Колонка `workflowSteps.isRequired` мертва — движок её не читает | — | Мёртвое поле |
| **E12** **NEW** | LOW (тест-дыра) | `approvals-security.test.ts:131-144` | Тест «valid approver → success» исполняет баг C1 (следующий шаг close) и не проверяет состояние заявки — ложная уверенность | — | Тест должен ловить C1 |
| **F5** **NEW** | LOW | `App.tsx:1729-1732,1762-1766` | Модалка «Добавить КП»: два одинаковых поля «Сумма КП» на один state | Закупка → Добавить КП | Одно поле |
| **F9** **NEW** | LOW | `App.tsx:744-752` | Фильтр статусов списка без finance_payment/delivery/receiving/issue | — | Полный набор |
| **F11** **NEW** | LOW | `App.tsx:962` | `quantity \|\| 1`: qty=0 молча → 1; unitPrice всегда 0 → estimatedAmount=0 при создании из Mini App (вход для B3/H1) | Создать заявку qty=0 | Ошибка валидации vs подмена |
| **F12** **NEW** | LOW | `App.tsx:906-917` | Логика «срочность↔дата» завязана на hardcoded ключ `cf_urgency` — ломается при переименовании поля в FormBuilder | — | Конфигурируемость |
| **B16** **NEW** | INFO | `routes.ts:571-573` | fromStatus читается до транзакции — под гонкой возможно лишнее уведомление; на данные не влияет | — | — |
| **F10** **NEW** | INFO | `web/src/admin/People.tsx:194-201,349-358` | Dropdown ролей включает owner/admin — фронт полагается на серверный анти-эскалационный guard (он есть: admin.routes.ts:739-748) | — | ОК на бэке, UX-шум |

## Карта жизненного цикла (дефолтный tenant-workflow)

```
Создание (requests.create) → status=statusForStep(шаг 1), history+audit, pending если шаг1=approval
 1. approval «Рук. отдела»      approve[PIN]/reject     resolve pending→signature; SoD
 2. warehouse_check             wh_in_stock/wh_out_of_stock/reject → request.inStock ветвит дальнейшее
    ├─ inStock=true → шаги 3–9 выпадают → 10
 3. procurement {inStock:false} add_quotation (не двигает; estimatedAmount=последнее КП!) /
                                select_supplier (двигает, фиксирует сумму) / reject
 4. approval «Финансы»   (threshold ≥ 5M)
 5. approval «Директор»  (threshold ≥ 30M)      пороги от estimatedAmount на момент шага
 6. approval «Учредитель»(threshold ≥ 100M)
 7. finance_payment {inStock:false}  mark_paid[PIN]/reject
 8. delivery {inStock:false}         mark_arrived/reject        (⚠ не покрыт тестами)
 9. receiving {inStock:false}        receive_goods/reject       (⚠ не покрыт; income в пул NULL)
10. issue                            issue/reject               (outcome из NULL; fail-loud + откат)
11. close (perm requests.create)     close → TERMINAL closed    (без close-шага конец = approved)
Reject на любом шаге → TERMINAL rejected (только ответственный за шаг)
```

Инварианты: status↔currentStepId атомарны во всех ветках ✅ (но в approveApproval значение status неверно — B1); history+audit ✅ canonical / дыры в compat (E5); one-pending — индекс ✅, логика ❌ (B1); signature после PIN ✅ canonical / ❌ compat (E6) и L2-ветка; склад атомарен, fail-loud, полный откат ✅; идемпотентность слепа к шагу/складу ⚠ (B5/E2).

## Вердикты по ролям (18)

| Роль | Вердикт | Комментарий |
|---|---|---|
| owner | OK | 'all'; override только в compat, PIN обязателен |
| admin | спорно | Не бизнес-апрувер (покрыто тестом). Но R6: может архивировать owner; в compat лишние склад/закупки (R4) |
| director | спорно | Canonical OK; compat — лишние warehouse/quotations (R4) |
| finance | OK | mark_paid + approvals по роли шага |
| procurement | OK | quote/select работают |
| warehouse | спорно (M8) | approvals.approve/reject + мёртвые reserve/adjust |
| dept_head | спорно | Видит все заявки холдинга через approvals.view (R9) |
| requester | OK | comment мёртв (M5); скоуп-баг R5 при узком назначении |
| warehouse_worker | проблема (compat) | Заблокирован в compat (R4); canonical OK |
| procurement_head | проблема (compat) | R4; canonical OK |
| finance_head | проблема (compat) | R4; canonical OK |
| deputy_director | спорно | Функционально узкий: finance.view без mark_paid |
| operations_lead | спорно | В админку попадает (workflows/settings.manage), но Склад/Закупки в UI недостижимы (F1) |
| procurement_manager | проблема (compat) | R4; canonical OK |
| finance_manager | проблема (compat) | R4; canonical OK |
| accountant | OK | read-only финансов; экрана Финансы в UI нет |
| auditor | спорно | audit.export мёртв; заявки холдинга не видит (не в OVERSIGHT) |
| observer | проблема | R8: пустой список заявок в canonical; в compat наоборот видит всё |

## Пробелы тестового покрытия (для Фазы 4)

1. `mark_arrived` (delivery) — не исполняется ни одним тестом.
2. `receive_goods` (income через lifecycle) — не исполняется.
3. Полная out-of-stock цепочка (8 звеньев) — отсутствует.
4. C1-сценарий (orphan + 23505) — существующий тест исполняет путь, но не проверяет состояние (E12).
5. M2/E3 — частичная поставка (второй income по той же паре).
6. E2 — приёмка в именованный склад + issue из NULL-пула.
7. M4 — SoD для не-approve действий.
8. M6 — конкурентный double-approve.
9. Легаси-переходы (override, receive-close) — history/audit.
10. Draft-тупик (B10/E9).
