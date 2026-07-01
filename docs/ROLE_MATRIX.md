# Factory OS — Role Matrix (P2.2)

Канонические роли, их область видимости (scope), что можно/нельзя, какие действия требуют PIN, и какие permission-коды за этим стоят.

Права — это данные: каталог в `src/rbac/permissions.ts`, маппинг ролей на коды в `src/rbac/system-roles.ts`. Ничего не захардкожено на имя роли — гейт всегда = **permission + (для approval-шага) роль-согласующий шага + scope**. Frontend-скрытие кнопок не заменяет backend-проверку.

## Канон ↔ код

| Канон | Код в системе | Примечание |
|---|---|---|
| owner | `owner` | права = all |
| director | `director` | |
| deputy_director | `deputy_director` | |
| operations_lead | `operations_lead` | |
| department_head | `dept_head` | имя кода отличается |
| requester | `requester` | |
| warehouse_manager | `warehouse` | имя кода отличается |
| warehouse_worker | `warehouse_worker` | |
| procurement_head | `procurement_head` | |
| procurement_manager | `procurement_manager` | |
| finance_head | `finance_head` | |
| finance_manager | `finance_manager` | |
| accountant | `accountant` | |
| auditor | `auditor` | |
| admin | `admin` | системный админ, НЕ бизнес-согласующий |
| observer | `observer` | только чтение |

Дополнительно в сиде есть легаси-роли `finance`, `procurement` (generic, оставлены для совместимости — предпочитать head/manager). Supplier user — future, не активная workflow-роль.

## Каталог permissions (33 кода)

- **requests**: view, create, edit, comment, upload_attachment
- **approvals**: view, approve, reject, override
- **warehouse**: view, check_stock, reserve, receive, issue, adjust
- **procurement**: view, quote, select_supplier, manage
- **suppliers**: view, manage
- **finance**: view, mark_paid, approve_payment
- **admin**: users.view, users.manage, roles.manage, workflows.manage, settings.view, settings.manage
- **audit**: view, export · **reports**: view

## Data scope (видимость заявок)

- `requester`, `observer` → **только свои** заявки (нет oversight-права).
- остальные (есть любое из `approvals.view` / `warehouse.view` / `procurement.view` / `finance.view` / `audit.view` / `requests.edit`) → **весь holding**.
- Департаментный scope для `dept_head` — задокументированный future-refinement (сейчас holding-wide).

## Sensitive (PIN) действия

- `approve` на approval-шаге → **PIN** (роли с `approvals.approve`).
- `mark_paid` на finance_payment-шаге → **PIN** (`finance.mark_paid`).
- Stock `adjust` → **PIN** (future, `warehouse.adjust`).
- PIN никогда не логируется.

## Audit-события (по возможностям роли)

`request.created/approve/reject/wh_in_stock/issue/close`, `approval.approved/rejected`, `stock.received/issued`, `user.archived`, и т.д. — пишутся в `audit_logs` каждым sensitive-действием.

---

## По ролям

### owner (`owner`) — scope: holding
- **Можно:** всё по holding; approve где назначен (PIN); audit; export. Права = all.
- **Нельзя:** обходить audit; approve шаг, где он не назначен согласующим (гейтинг роли всё равно действует).
- **PIN:** approve / mark_paid. **Коды:** all.

### director (`director`) — scope: holding (oversight)
- **Можно:** approve/reject **назначенный** approval-шаг (PIN); видеть заявки, склад/финансы-статусы, audit timeline.
- **Нельзя:** issue склада; mark paid; manage users; approve шаг с другим approver-role.
- **PIN:** approve. **Коды:** requests.view, approvals.view/approve/reject/override, finance.view, audit.view, reports.view, users.view.

### deputy_director (`deputy_director`) — scope: holding (oversight)
- **Можно:** approve назначенные approvals; request changes; смотреть операционку и финансы-статусы.
- **Нельзя:** менять склад; mark paid; manage roles.
- **PIN:** approve. **Коды:** requests.view, reports.view, finance.view, approvals.view/approve/reject.

### operations_lead (`operations_lead`) — scope: holding (oversight)
- **Можно:** создавать/смотреть заявки; видеть склад/закупки/финансы-статусы; audit; настраивать workflow/settings если дано.
- **Нельзя по умолчанию:** approve платежи; mark paid; напрямую менять сток; удалять юзеров.
- **PIN:** —. **Коды:** requests.view/create, reports.view, audit.view, warehouse.view, procurement.view, finance.view, workflows.manage, settings.manage.

### department_head (`dept_head`) — scope: department (сейчас holding-wide, future: dept)
- **Можно:** создавать заявки; approve назначенные department-level approvals; request changes; комментировать.
- **Нельзя:** issue склада; mark paid; manage users; видеть чужие департаменты (future-scoping).
- **PIN:** approve. **Коды:** requests.view/create, approvals.view/approve/reject.

### requester (`requester`) — scope: own
- **Можно:** создать заявку; загрузить вложение и комментировать свою заявку; отслеживать статус.
- **Нельзя:** видеть чужие заявки; approve свою заявку; issue склада; manage users; финансы; audit вне своей заявки.
- **PIN:** —. **Коды:** requests.view, create, comment, upload_attachment.

### warehouse_manager (`warehouse`) — scope: holding (oversight)
- **Можно:** warehouse_check; issue; receive; reserve; видеть остатки/материалы/движения.
- **Нельзя:** approve как директор; mark paid; manage users; видеть финансы.
- **PIN:** adjust (future). **Коды:** requests.view, approvals.view/approve/reject, warehouse.view/check_stock/reserve/receive/issue/adjust.

### warehouse_worker (`warehouse_worker`) — scope: holding (oversight склада)
- **Можно:** assigned check/receive/issue если дано.
- **Нельзя:** adjust сток; approve; видеть финансы/admin/audit.
- **PIN:** —. **Коды:** requests.view, warehouse.view/check_stock/receive/issue.

### procurement_head (`procurement_head`) — scope: holding (oversight)
- **Можно:** procurement view; quote; select_supplier; approve назначенные approvals.
- **Нельзя:** mark paid; issue склада; approve не назначенное.
- **PIN:** approve. **Коды:** requests.view, reports.view, procurement.view/quote/select_supplier, suppliers.view/manage, approvals.view/approve/reject.

### procurement_manager (`procurement_manager`) — scope: holding (oversight)
- **Можно:** видеть закупки; quote; select_supplier.
- **Нельзя:** approve high-level (если не назначен); mark paid; issue склада; manage users.
- **PIN:** —. **Коды:** requests.view, approvals.view, procurement.view/quote/select_supplier, suppliers.view/manage.

### finance_head (`finance_head`) — scope: holding (oversight)
- **Можно:** finance view; mark_paid (PIN); approve назначенные approvals.
- **Нельзя:** issue склада; manage warehouse; approve не-финансовые не назначенные.
- **PIN:** mark_paid, approve. **Коды:** requests.view, reports.view, finance.view/mark_paid, approvals.view/approve/reject.

### finance_manager (`finance_manager`) — scope: holding (oversight)
- **Можно:** finance view; mark_paid (PIN) если назначен.
- **Нельзя:** менять сток; manage users; approve как директор.
- **PIN:** mark_paid. **Коды:** requests.view, approvals.view, finance.view/mark_paid.

### accountant (`accountant`) — scope: holding (oversight finance)
- **Можно:** видеть финансы и заявки (read).
- **Нельзя:** approve платежи по умолчанию; issue склада; manage roles.
- **PIN:** —. **Коды:** requests.view, finance.view.

### auditor (`auditor`) — scope: holding (read-only)
- **Можно:** смотреть audit/DNA timeline; export audit; read-only операционка.
- **Нельзя:** создавать заявки; approve; issue; mark paid; редактировать юзеров; мутировать бизнес-данные.
- **PIN:** —. **Коды:** requests.view, reports.view, audit.view, audit.export, suppliers.view.

### admin (`admin`) — scope: holding
- **Можно:** manage users; assign roles; manage workflows/structure; archive users; settings; audit.
- **Нельзя автоматически:** approve бизнес-заявки; issue склада; mark paid; обходить audit. **Admin = системный админ, не бизнес-согласующий.**
- **PIN:** —. **Коды:** users.view/manage, roles.manage, workflows.manage, settings.manage, audit.view, requests.view, reports.view, suppliers.view/manage.

### observer (`observer`) — scope: own / read-only
- **Можно:** read-only страницы по scope (свои заявки, отчёты если дано).
- **Нельзя:** мутировать что-либо; approve; issue; upload; manage users; export без явного права.
- **PIN:** —. **Коды:** requests.view, reports.view.
