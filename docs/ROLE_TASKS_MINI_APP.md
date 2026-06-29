# Factory OS — Role Tasks in the Mini App (P2.2)

Что каждая роль видит в Telegram Mini App: меню, inbox-задачи, кнопки, скрытые экраны, поведение next-action.

Принципы:
- Меню и табы гейтятся по permission в `web/src/App.tsx` (`BottomNav`) и `web/src/admin/AdminPanel.tsx`.
- Кнопки действий на детали заявки приходят с backend (`availableActions()`), уже отфильтрованные по роли/праву/scope/PIN — **frontend их не перепроверяет**.
- Next-action подсказка на текущем шаге таймлайна — по `stepKind` (`approval → «Ожидает согласования»`, `warehouse_check → «Склад должен проверить наличие»`, `issue → «Склад должен выдать материал»`, `close → «Ожидает подтверждения получения»`).
- Inbox (`GET /requests/inbox`) — role-aware: показывает то, по чему роль может действовать.

| Роль | Меню Mini App | Inbox-задачи | Кнопки/действия | Скрыто | Next-action |
|---|---|---|---|---|---|
| **requester** | Главная · Заявки (свои) · Меню/Профиль | обновления своих заявок | Создать заявку, Открыть, Загрузить файл, Комментарий, Подтвердить получение (на close) | Согласования, Склад, Админ | по своей заявке: текущий шаг + «ждёт согласования/склада…» |
| **department_head** | Главная · Заявки · Согласования · Меню | назначенные approvals (department) | Создать, Согласовать (PIN)/Отклонить (на своём шаге) | Склад, Админ | «Ожидает согласования» на своём шаге |
| **director / deputy_director** | Главная · Заявки · Согласования · Меню | назначенные approvals | Согласовать (PIN), Отклонить (comment), Открыть | Склад-операции, Админ | «Ожидает согласования директора» |
| **operations_lead** | Главная · Заявки · (Согласования если назначен) · Меню | назначенные задачи | Создать, Открыть, смотреть статусы | mark paid, прямые сток-операции | информативно |
| **warehouse_manager / warehouse_worker** | Главная · Заявки · Склад · Меню | warehouse_check / issue / receive задачи | «В наличии»/«Нет в наличии», «Выдать», «Принять» (на своём шаге) | Согласования директора, Финансы, Админ | «Склад должен проверить наличие» → «…выдать материал» |
| **procurement_head / procurement_manager** | Главная · Заявки · (Согласования если назначен) · Меню | procurement-задачи (placeholder/КП) | Добавить КП, Выбрать поставщика *(когда модуль готов)* | mark paid, склад-issue, Админ | «Снабжение подбирает поставщика» |
| **finance_head / finance_manager** | Главная · Заявки · (Согласования) · Меню | оплата/approvals задачи | Отметить оплату (PIN) *(на finance_payment-шаге)* | склад-операции, Админ | «Ожидает оплаты» |
| **accountant** | Главная · Заявки · Меню | placeholder finance-задачи | read; *(future: загрузка платёжных док-в)* | approve, склад, Админ | информативно |
| **auditor** | Главная · Аудит/DNA · Заявки (read) · Меню | placeholder audit-алерты | только просмотр; export если дано | любые мутации | read-only |
| **admin** | Главная · Заявки · **Админ** (Структура/Люди/Роли/Workflow/Материалы/Аудит/Настройки по правам) · Меню | системные/admin задачи | manage users/roles/workflows/structure, archive user | бизнес-approve, склад-issue, mark paid | n/a |
| **observer** | Главная · (Заявки read по scope) · Меню | — | только просмотр | мутации, approve, upload, Админ | read-only |
| **owner** | как director + executive overview по holding | назначенные approvals | как назначено + просмотр всего | — | как назначено |

## Placeholder'ы (модули ещё не готовы)

- **Procurement** экраны (queue, suppliers, quotations) — показывать как placeholder при наличии `procurement.*` прав; полноценные действия — после Procurement Lite.
- **Finance** экраны (payment queue, invoices) — placeholder при `finance.*`; действия — после Finance Lite.
- Эти роли уже получают корректные permission-коды (каталог готов), но соответствующие endpoints/экраны — future.
