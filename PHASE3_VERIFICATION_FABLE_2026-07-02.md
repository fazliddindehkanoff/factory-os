# Factory OS — Фаза 3: верификация находок отчёта Opus 4.8 (Fable 5)

**Дата:** 2026-07-02. Каждая находка из `FUNCTIONAL_TEST_2026-07-02.md` проверена по файл:строка независимым анализом (4 направления Фазы 2 + прямое чтение + воспроизводящий тест для C1/B2).

## Таблица верификации

| ID | Вердикт | Доказательство |
|---|---|---|
| **C1** | ✅ **ПОДТВЕРЖДЕНА** (CRITICAL) | **Воспроизведена тестом** `src/services/approval-branch-sync.test.ts` (3/3 падения до фикса): (1) после approve на шаге 1 (следующий — warehouse_check) `status='pending_approval'` вместо `warehouse_check`; (2) orphan pending создан; `wh_in_stock` → HTTP 500 (23505 по `approvals_one_pending_idx`) — заявка застревает; (3) см. B2. Дефолтный tenant-workflow уязвим (шаг 2 = warehouse_check, `tenant-setup.ts:30-31`) |
| **H1** | ✅ ПОДТВЕРЖДЕНА (HIGH, конфиг) | `engine.ts:63-72` — только вперёд по stepOrder; ctx пересчитывается (`lifecycle.service.ts:376-380`), но прошедшие шаги не пересматриваются. Конструктор не валидирует порядок. Смягчение, не отмеченное Opus: правка шагов блокируется при in-flight заявках (`admin.routes.ts:1142-1146,1190-1193`). Дефолтный сид безопасен (thresholds на orders 4-6 после procurement 3) |
| **H2** | ✅ ПОДТВЕРЖДЕНА (HIGH) | `App.tsx:275-277` — else-if; альтернативных путей к экранам Склад/Закупки нет (Home quick-actions и Меню их не содержат). Матрица комбинаций прав — в отчёте Фазы 2 |
| **H3** | ✅ ПОДТВЕРЖДЕНА, severity MEDIUM-условная корректна | Только при `SERVE_DESIGN=1`. Проверено: `env.ts:29-33` требует явного значения вне development; `.env.example`=0; `src/server/index.ts:17` — строго `==='1'`. В compat-слое найдены ДОПОЛНИТЕЛЬНЫЕ дыры (R1-R3, E5, E6 в отчёте Фазы 2) |
| **M1** | ✅ ПОДТВЕРЖДЕНА, уточнены строки | Реальные строки: `web/src/screens/Warehouse.tsx:36-41,149-152` (у Opus — `Warehouse.tsx:110`). Permissions в экран не передаются; формы видны при только `warehouse.view` |
| **M2** | ✅ ПОДТВЕРЖДЕНА + **УСИЛЕНА** | `warehouse.service.ts:73-86` — ключ без шага. Усиление (E2, HIGH): ключ также не учитывает СКЛАД, а lifecycle работает только с пулом `warehouseId=NULL` → ручная приёмка в именованный склад с requestId блокирует lifecycle-income → `issue` навсегда «Недостаточно остатка» |
| **M3** | ✅ ПОДТВЕРЖДЕНА | `lifecycle.service.ts:417-423` — молчаливый пропуск позиций без materialId/qty≤0, warning нет |
| **M4** | ✅ ПОДТВЕРЖДЕНА | `lifecycle.service.ts:181,198,255-257` — SoD только для action='approve' |
| **M5** | ✅ ПОДТВЕРЖДЕНА, список расширен | 10 мёртвых прав (у Opus 9): + `users.view` мёртв в canonical (единственное использование — compat:901). `approvals.override`/`warehouse.reserve`/`reports.view` живут только как UI-метки |
| **M6** | ✅ ПОДТВЕРЖДЕНА | `approval.service.ts:104-121` — нет FOR UPDATE (у performAction есть — lifecycle:243) |
| **M7** | ✅ ПОДТВЕРЖДЕНА + УСИЛЕНА | Все модульные эндпоинты проверяют target `{holdingId}` (`routes.ts:319,356,646,683,769,798,828,858,921,1054`). Усиление (R5): админка сама позволяет создать суженное назначение → 403 даже на requests.view/create — фича ломает базовый доступ |
| **M8** | ✅ ПОДТВЕРЖДЕНА (design) | `system-roles.ts:74-84`. Важно: `approvals.reject` складу НУЖЕН по конструкции — reject на warehouse_check-шаге требует это право (`step-kinds.ts:53-60`). Спорным остаётся только `approvals.approve` |
| **M3b** | ✅ ПОДТВЕРЖДЕНА | Бэкенд не фильтрует `estimatedAmount`/`quotations` (`routes.ts:334-343,517-521`); скрытие только клиентское (`App.tsx:668,796,1502-1503`). Смягчение: видимость own-or-oversight |
| **L2** | ✅ ПОДТВЕРЖДЕНА | `lifecycle.service.ts:353-373` — `if (pending)`, иначе молча продвигается без записи и подписи |
| **L3** | ✅ ПОДТВЕРЖДЕНА | `lifecycle.service.ts:401` — closed только для kind close; конец на issue → approved (при этом closedAt ставится) |
| **L4** | ✅ ПОДТВЕРЖДЕНА | `lifecycle.service.ts:290,326` (`patch.estimatedAmount = amt` на каждый add_quotation) |
| **L5** | ✅ ПОДТВЕРЖДЕНА, значимость ниже заявленной | `App.tsx:248,1511-1513`. Все 18 системных ролей имеют `requests.view` — затрагивает только кастомные роли |
| **L6** | ✅ ПОДТВЕРЖДЕНА (путь мёртвый) | `App.tsx:1691` — `>=0` vs `>0`; сейчас `amount:true` существует только вместе с `quote='add'`, т.е. ветка недостижима — фиксить для будущей согласованности |
| **L8** | ✅ ПОДТВЕРЖДЕНА | `routes.ts:177-255` — /config отдаёт оргструктуру + id/ФИО всех активных сотрудников любому члену холдинга |
| **L9** | ✅ ПОДТВЕРЖДЕНА + расширена | `screens/Menu.tsx` — 0 импортов. Расширение (F4, MEDIUM): дубликат `shared.tsx` разошёлся с App.tsx — в App.tsx statusMeta НЕТ статусов finance_payment/delivery/receiving/issue → сырые коды в UI |
| **L10** | ✅ ПОДТВЕРЖДЕНА (конфиг) | `seed-pilot.ts:52-57`: pilot без procurement-ветки; wh_out_of_stock → issue → тупик «Недостаточно остатка» |

**Итог: 20/20 подтверждены** (0 опровергнуты). Коррекции severity: M2 — усилена связкой с E2 (HIGH в комбинации); L5 — практическая значимость ниже; M8 — reject-половина находки снимается (by design).

## Новые находки Фазы 2/3 (сверх отчёта Opus)

Полные описания — в `PHASE2_FUNCTIONAL_TEST_FABLE_2026-07-02.md`. Ключевые:

| ID | Severity | Суть |
|---|---|---|
| **B2** | HIGH | `approval.service.ts:82` — orphan pending на терминальной заявке переоткрывает её (подтверждено тестом: 200 вместо 409) |
| **E2** | HIGH | Рассинхрон складских пулов (NULL vs именованный) × слепой ключ идемпотентности |
| B8 | MEDIUM | Нет unique-индекса `stock_balances` → гонка двух первых приходов = две строки баланса |
| B9 | MEDIUM | `approverRoleId` уважается только для approval-шагов; close чужой заявки любым `requests.create` |
| R5 | MEDIUM | Суженные назначения ролей (фабрика/отдел) ломают доступ ко всем модульным эндпоинтам |
| R6 | MEDIUM | `users.manage` может архивировать owner'а / отзывать его роль |
| E5 | MEDIUM | Compat-переходы без history (override, receive-close) и без audit (quotations) |
| E6/R1-R3 | MEDIUM | Compat: подпись без PIN; /warehouse/stock без прав; approve/reject без permission-гейта |
| F4 | MEDIUM | Разошедшиеся копии statusMeta (App.tsx vs shared.tsx) — сырые статусы в UI |
| R8 | LOW | Observer видит пустой список заявок (OVERSIGHT без reports.view) |
| B10/E9 | LOW | Draft-тупик с вводящим в заблуждение сообщением |
| E12 | LOW | Существующий тест исполняет C1-путь, но не проверяет состояние (ложно-зелёный) |
| F5/F9/F11/F12, R9/R10, E10, B16, F10 | LOW/INFO | См. отчёт Фазы 2 |
