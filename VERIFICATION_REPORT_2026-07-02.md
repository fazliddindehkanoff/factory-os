# Письмо: независимая проверка fix-ветки Factory OS перед merge/pilot

**Кому:** команда Factory OS (Бунёд, Сарвар, Матиас)
**От:** независимая проверка (Claude Fable 5), режим read-only — код не менялся
**Дата:** 2026-07-02
**Предмет:** ветка `fix/audit-p0-p1-p2-2026-07-02`, отчёт `FIX_REPORT_FABLE5_2026-07-02.md`

---

Привет.

Проверил fix-ветку не по словам отчёта, а по коду и фактическим прогонам. Кратко: **сами исправления реализованы и подтверждены — все P0/P1/P2 закрыты, 208/208 тестов проходят независимо.** Но есть **один процессный блокер merge** и **один новый баг средней важности**, которые нужно закрыть до pilot. Ниже детали.

---

## 1. Executive verdict

| Решение | Вердикт | Почему |
|---|---|---|
| **Merge** | **NO-GO сейчас → GO после коммита** | В ветке **нет ни одного коммита** сверх `main`. Все правки, миграции и тесты — незакоммиченные/untracked изменения в рабочем дереве. Мержить нечего (см. NEW-1) |
| **Demo** | **GO** | Golden-path зелёный, регрессий нет |
| **Pilot** | **GO при условиях** | После коммита+merge, применения миграций `0011/0012`, отзыва PAT, `SERVE_DESIGN=0` и фикса NEW-2 |
| **Production** | **NO-GO** | Вне скоупа спринта остаётся финконтур и инфра-пункты; безопасность P0/P1/P2 — закрыта |

Главный сигнал: **фиксы качественные и проверяемые, но ветка физически не готова к merge — её сначала нужно закоммитить.**

---

## 2. Verification summary

| Область | Статус | Доказательство | Риск |
|---|---|---|---|
| P0-1 wipe-guard | ✅ Verified | `_wipe-guard.ts` + 3 скрипта импортируют `assertWipeAllowed`; 8 тестов | нет |
| P0-2 secrets | ✅ Verified | `git remote` чистый; `git grep` секретов — пусто; только `.env.example` в git | требуется ручной revoke PAT |
| P1-1 threshold | ⚠️ Verified с оговоркой | активация проверяет procurement перед threshold; **но step-мутации активного workflow — нет (NEW-2)** | средний |
| P1-2 compat PIN | ✅ Verified | PIN обязателен для любой роли; тест на custom-role без PIN → 403 | нет |
| P1-3 compat RBAC | ✅ Verified | анти-эскалация по правам + revoke вместо delete; 2 теста | нет |
| P1-4 quote after approval | ✅ Verified | select только на procurement-шаге → иначе 409; 2 теста | нет |
| P1-5 bot scope | ✅ Verified | `docs/TELEGRAM_BOT_SCOPE.md` + README; approve без PIN невозможен | нет |
| P1-6 notifications | ✅ Verified | таблица+миграция; created→delivered/failed; retry; эндпоинты; 4 теста | нет |
| P1-7 server search | ✅ Verified | фильтры в БД + total; фронт debounce 350ms; параметризовано (без инъекций); 2 теста | нет |
| P1-8 cascade→restrict | ✅ Verified | 7 FK restrict; hard-delete истории падает; 4 теста | нет |
| P2-1 terminal statuses | ✅ Verified | общий `TERMINAL_STATUSES`; dashboard/admin/compat/lifecycle согласованы | нет |
| P2-2 PIN change | ✅ Verified | старый PIN обязателен; admin-reset с audit+notify; PIN нигде не логируется; 2 теста | нет |
| P2-3 warehouse scope | ✅ Verified | warehouse/request/material проверяются по холдингу; join'ы holding-scoped; 3 теста | нет |
| Тесты | ✅ Verified | нет `.only/.skip/.todo`; независимый прогон 208/208 | нет |

---

## 3. P0 verification

| ID | Verified? | Доказательство | Остаточный риск |
|---|---|---|---|
| **P0-1** | ✅ Да | `evaluateWipeGuard`: prod→отказ (незаданный NODE_ENV=prod, fail-closed), `FORCE_WIPE` + `WIPE_TARGET_DB`=имя БД обязательны, audit только по `FORCE_DELETE_AUDIT=1`; хардкод owner-id убран. Guard импортирован в reset-tenant/clear-requests/reset-roles. 8 unit-тестов. Случайный запуск против прод-БД — отклоняется. | `fix-step-kinds.ts` делает UPDATE step_kind без guard — **не** wipe (не трогает users/roles/requests/audit/stock), риск низкий; можно добавить guard для единообразия |
| **P0-2** | ✅ Да | `git remote -v` → чистый HTTPS без токена; `git grep` по `ghp_/github_pat_/BOT_TOKEN=/@` — пусто; `.env` не в git (только `.env.example`); README-предупреждение добавлено | **Владелец обязан вручную отозвать старый PAT в GitHub** — локальное удаление не отзывает токен |

---

## 4. P1 verification

| ID | Verified? | Доказательство | Остаточный риск |
|---|---|---|---|
| **P1-1** | ⚠️ Частично | `assertThresholdsHaveProcurement` вызывается при активации (admin.routes:1226); рантайм безопасен по конструкции; 3 теста (без procurement→400, с procurement→201, zero-amount не обходит). | **NEW-2 (P2):** на уже активном workflow без in-flight-заявок можно добавить/удалить шаги — существующий инвариант НЕ перезапускается (только ordering). Частично переоткрывает P1-1 |
| **P1-2** | ✅ Да | compat approve всегда требует PIN (условие finance/director/owner убрано); current-approver/active/idempotency — в сервисе; тест custom-role без PIN → 403 | нет |
| **P1-3** | ✅ Да | `canGrantRole`: нельзя выдать роль с правами выше своих; `setSingleRole` ревокает, не удаляет; тесты: users.manage не выдаёт finance (403), reassign сохраняет историю | нет |
| **P1-4** | ✅ Да | select КП только когда текущий шаг = procurement; иначе 409 `REAPPROVAL_REQUIRED`; terminal тоже блок; тесты на procurement/после-согласования | нет |
| **P1-5** | ✅ Да | doc + README честно фиксируют «notifications + launcher», список future tasks; approve через бота невозможен (бот только шлёт кнопку Mini App) | нет (продуктовая честность) |
| **P1-6** | ✅ Да | `notifications` в schema+`0012`; строка создаётся до отправки; success→delivered, throw→failed(+error); `retryFailedNotifications` + скрипт; эндпоинты list/unread/read (только свои); тесты симулируют успех и провал | compat approve/reject не шлёт уведомлений (легаси, off в prod) — P3 |
| **P1-7** | ✅ Да | `GET /requests`: search/status/priority/factory/department/requester/date/page — всё в БД; `total` через `count()`; фронт шлёт params с debounce; LIKE экранирован, значения параметризованы (drizzle) — инъекций нет; 2 теста (поиск вне первой страницы, фильтр статуса) | нет |
| **P1-8** | ✅ Да | 7 FK (items/status_history/approvals/signatures/reservations/quotations/attachments) → restrict; `stock_movements.requestId` уже без cascade; `audit_logs` не ссылается на requests; hard-delete заявки с историей падает (4 теста); dev-скрипт чистит детей явно + под guard | нет |

---

## 5. P2 verification

| ID | Verified? | Доказательство | Остаточный риск |
|---|---|---|---|
| **P2-1** | ✅ Да | `TERMINAL_STATUSES` (approved/closed/rejected/cancelled/archived) в step-kinds; dashboard, admin in-flight, compat override и quote-select берут оттуда; canonical lifecycle блокирует closed через `currentStepId=null`; EDITABLE не включает closed; тест | нет |
| **P2-2** | ✅ Да | смена существующего PIN требует старый (+lockout); audit `pin.changed`/`pin.set`; admin reset (`users.manage`+reason+audit+notify, PIN очищается → нельзя подписывать до нового); PIN нигде не логируется (grep чист); хранится scrypt-хэш; 2 теста | нет |
| **P2-3** | ✅ Да | receive/issue валидируют warehouseId+requestId по холдингу; material — уже проверялся; join'ы баланса holding-scoped; 3 теста (чужой склад→400, чужая заявка→400, свой→200) | нет |

---

## 6. Migration review

| | Статус |
|---|---|
| **0011_restrict_history_deletes** | ✅ Применяется чисто (доказано pglite: RESTRICT реально блокирует delete). `DROP CONSTRAINT IF EXISTS` + `ADD` — безопасно на БД с данными (RESTRICT влияет только на будущие удаления, существующие строки не трогает). `_journal.json` обновлён (idx 11) |
| **0012_notifications** | ✅ `CREATE TABLE IF NOT EXISTS` + 2 FK + 2 индекса; колонки schema ↔ миграция совпадают (15 полей); `_journal.json` обновлён (idx 12) |
| **Staging readiness** | Готовы. Применять `npm run db:migrate` на staging до pilot |
| **Rollback** | Миграции аддитивны. Откат 0012 = `DROP TABLE notifications`. Откат 0011 = вернуть FK на cascade (в проде не требуется — restrict строже). Migrator не перезапускает применённые миграции; ручной повтор `ADD CONSTRAINT` без IF NOT EXISTS упадёт — но это не путь эксплуатации |
| **Замечание** | `meta/0009_snapshot.json` отсутствовал и до этой ветки (легаси-долг drizzle) — на применение миграций не влияет |

---

## 7. Test results (независимый прогон, чистая среда)

```
npm run typecheck        →  OK (tsc --noEmit)
npm test                 →  Test Files 39 passed (39), Tests 208 passed (208)
npm run build            →  OK (tsc -p .)
cd web && npm run build  →  OK (vite build, 340.9 kB / gzip 93.3 kB)
EXIT=0
```

Проверено дополнительно:
- Нет `.only` / `.skip` / `.todo` / `xit` / `xdescribe` в тестах (grep пусто).
- 8 новых тест-файлов покрывают именно фиксы (guard, threshold-активация, compat-hardening, pin-change, request-search, warehouse-scope, cascade-restrict, notifications).
- Тесты не «зелёные вхолостую»: проверяют негативные пути (403/409/410/400) и позитивные.

---

## 8. New issues found

| ID | Severity | Файл | Проблема | Ожидается | Предлагаемый фикс |
|---|---|---|---|---|---|
| **NEW-1** | **P1 (процесс, merge-блокер)** | вся ветка | В ветке нет коммитов сверх `main` — все фиксы/миграции/тесты незакоммичены и untracked. `git diff main..HEAD` пуст. CI на запушенной ветке прогонит **старый** код и «пройдёт» ложно; merge физически нечего делать | Закоммитить все изменения на ветке, запушить, только потом merge/CI | Сделать commit (по команде владельца) со всеми файлами из `git status` |
| **NEW-2** | **P2 (переоткрывает P1-1)** | `src/http/admin.routes.ts:1327-1370, 1287-1311, ~1390-1430` | На **уже активном** workflow без in-flight-заявок можно добавить threshold-approval без procurement (или удалить procurement) — шаг-мутации запускают только ordering-инвариант (`assertThresholdsAfterProcurement`), но не existence (`assertThresholdsHaveProcurement`). Активный workflow можно привести к «порог без закупки» → самодекларация суммы снова обходит согласование | Активный workflow не может иметь amount-gated approval без procurement перед ним | В POST/PUT/reorder/DELETE шагов: если `workflow.isActive === true`, вызвать `assertThresholdsHaveProcurement(tx, id)` внутри транзакции (по аналогии с активацией) |
| **NEW-3** | P3 | `scripts/fix-step-kinds.ts` | UPDATE `step_kind` напрямую по БД без wipe-guard (не деструктивно к данным, но правит workflow-конфиг на любой БД) | Для единообразия — тоже под guard или явное dev-предупреждение | Добавить `assertWipeAllowed`-подобную проверку окружения или пометить dev-only |
| **NEW-4** | P3 | `src/http/compat.routes.ts` (approve/reject/override) | Легаси-пути не создают notification-записей (расхождение с canonical). В prod compat-мутации отключены, риск только в dev/staging с `SERVE_DESIGN=1` | Согласованность уведомлений | При желании — прокинуть notify в compat или оставить (легаси выводится из эксплуатации) |

---

## 9. Required before merge (checklist)

- [ ] **Закоммитить всю fix-ветку** и запушить (NEW-1). Проверить, что коммит включает: `scripts/_wipe-guard.ts`, `scripts/retry-notifications.ts`, `src/services/notification.service.ts`, `drizzle/0011_*`, `drizzle/0012_*`, все 8 новых тестов, изменённые `schema.ts/routes.ts/compat.routes.ts/admin.routes.ts/…`.
- [ ] Прогнать CI на **запушенной** ветке (сейчас 208/208 подтверждены только локально на рабочем дереве).
- [ ] Ревью diff по существу (после коммита появится непустой `git diff main..HEAD`).
- [ ] Решить по NEW-2: закрыть до merge **или** зафиксировать как обязательный пункт до pilot.

## 10. Required before pilot (checklist)

- [ ] **Отозвать старый GitHub PAT** в GitHub → Settings → Developer settings → Tokens (P0-2, действие владельца).
- [ ] Исправить **NEW-2** (existence-инвариант на шаг-мутациях активного workflow) + тест.
- [ ] Применить миграции на staging: `npm run db:migrate`; сделать бэкап БД (`deploy/backup.sh`) до этого.
- [ ] Env pilot: `NODE_ENV=production`, `SERVE_DESIGN=0`, `ENABLE_DEV_AUTH=0`; секреты ≥16 симв., не плейсхолдеры; `BOT_TOKEN` только на сервере.
- [ ] Убедиться, что guard-скрипты и demo-сиды не запускаются против прод-БД.
- [ ] Прогнать golden-path на staging (создание → согласование с PIN → склад → выдача → закрытие) — покрыт `full-chain-e2e`, но проверить на реальной БД.

## 11. Required before production (checklist)

- [ ] Финансовый контур (invoices/payments/partial/сверка/bank_reference) — если он в проде.
- [ ] In-app центр уведомлений (UI поверх готового бэкенда P1-6) + email-канал.
- [ ] TLS `rejectUnauthorized:true`; PIN-lockout/rate-limit в Redis (кластер); CSP в nginx; offsite/шифрованный бэкап.
- [ ] Audit-immutability на уровне БД (REVOKE/триггер), заполнять device/ip/роль-актёра.
- [ ] Закрыть NEW-3/NEW-4 (гигиена).

---

## Главное решение

1. **Merge fix-ветку?** — **Пока НЕТ**: в ветке нет коммитов, мержить нечего. **Да** — сразу после того, как изменения закоммичены, запушены и CI зелёный. Сами фиксы корректны.
2. **Готовить demo?** — **Да**, можно сразу (после коммита/merge). Golden-path и все проверки зелёные.
3. **Запускать limited pilot?** — **Да, при условиях**: закрыт NEW-2, отозван PAT, применены миграции на staging, env без legacy/dev-bypass (`SERVE_DESIGN=0`).
4. **Обязательно до pilot:** коммит+merge+CI; фикс NEW-2; revoke PAT; миграции на staging + бэкап; `SERVE_DESIGN=0`/`NODE_ENV=production`/`ENABLE_DEV_AUTH=0`.
5. **Что блокирует production:** отсутствие финконтура (если он нужен в проде) + инфра-пункты (TLS, кластерный lockout, in-app центр, audit-immutability). Дыры безопасности из аудита (P0/P1/P2) — **закрыты**.

Отдельно подчёркиваю: `SERVE_DESIGN=1` в проде безопасен только потому, что compat-мутации теперь отдают `410`. Но правильная конфигурация прод — **`SERVE_DESIGN=0`** (canonical-слой), а legacy держать выключенным.

С уважением,
независимая проверка (Fable 5)
