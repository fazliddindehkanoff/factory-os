# Factory OS — Procurement Lite (P2.3)

Нормализованная база поставщиков + поток котировок (КП) для ветки «нет в наличии → закупка». Это **foundation**, не маркетплейс.

## Когда заявка попадает в закупку

Workflow-шаг с `stepKind = procurement`. В стандартной цепочке шаг `warehouse_check` с действием «Нет в наличии» (`wh_out_of_stock`) направляет заявку на procurement-шаг (статус `procurement`).

Очередь закупок: `GET /api/procurement/queue` — заявки холдинга на procurement-шаге. Право `procurement.view`; у requester доступа нет.

## Поставщики (suppliers)

Нормализованная сущность `suppliers`, holding-scoped: `name` (обяз.), `inn`, `phone`, `email`, `contactPerson`, `category`, `rating`, `note`, `status (active | archived)`, таймстампы.

CRUD (`/api/suppliers`):

| Метод | Право | Поведение |
|---|---|---|
| `GET /suppliers` | `suppliers.view` | активные поставщики холдинга |
| `POST /suppliers` | `suppliers.manage` | создать; audit `supplier.created` |
| `PATCH /suppliers/:id` | `suppliers.manage` | обновить; audit `supplier.updated` |
| `DELETE /suppliers/:id` | `suppliers.manage` | **archive** (`status=archived`), не hard-delete; audit `supplier.archived` |

DELETE никогда не удаляет физически — котировки могут ссылаться на поставщика.

## Котировки (КП)

Таблица `quotations`: `supplierId` (FK на suppliers, authoritative) + `supplierName` (snapshot / legacy fallback), `amount`, `leadTime`, `note`, `selected`, `createdBy`.

**Добавить КП** — действие `add_quotation` на procurement-шаге (`POST /api/requests/:id/action`, payload `{ action, supplierId, amount, leadTime }`):
- право `procurement.quote` (или `procurement.manage`); requester / warehouse — нельзя;
- передан `supplierId` → валидируется в рамках холдинга, имя копируется в `supplierName` snapshot;
- legacy: можно передать только free-text `supplierName` — временный fallback;
- `amount > 0`;
- остаётся на procurement-шаге (можно добавить несколько КП);
- audit `quotation.created`.

**Выбрать поставщика** — действие `select_supplier` (`{ action, quotationId }`):
- право `procurement.select_supplier` (или `procurement.manage`);
- КП должно принадлежать заявке;
- ровно одно `selected = true` на заявку;
- продвигает workflow на следующий шаг;
- audit `supplier.selected`.

## Single-quotation warning

Если выбирают поставщика, когда по заявке **только одно КП** — не блокируем (единственный поставщик иногда допустим), но возвращаем предупреждение в `result.warnings`:

```text
"Только одно КП по заявке — сравнение цен невозможно"
```

## Permissions

`suppliers.view`, `suppliers.manage` (procurement_head/manager и legacy procurement, admin — view+manage; auditor — view). `procurement.view/quote/select_supplier/manage` — как раньше.

## Известные ограничения (future)

- UI: procurement-очередь и список поставщиков в Mini App — placeholder (P2.3a / P2.4).
- Нет рейтинг-движка, сравнения цен, истории/документов поставщика, аналитики закупок — намеренно вне scope.
- `add_quotation` legacy free-text `supplierName` оставлен временно; предпочитать `supplierId`.
- Оплата выбранного поставщика — Finance Lite, отдельный этап.
