# Factory OS — Отчёт об исправлении P0/P1/P2 (Fable 5)

**Дата:** 2026-07-02 · **Исполнитель:** Claude Fable 5 · **Ветка:** `fix/audit-p0-p1-p2-2026-07-02`
**Источник задач:** аудит `AUDIT_FABLE5_2026-07-02.md` / `AUDIT_FABLE5_FULL_2026-07-02.md`.
**Режим:** правки только по скоупу P0/P1/P2; новые крупные модули (AI/OCR/Finance full/Reports/Desktop) не делались.

---

## 1. Summary

| Пункт | Статус |
|---|---|
| P0 исправлено | **Да** (P0-1, P0-2) |
| P1 исправлено | **Да** (P1-1..P1-8) |
| P2 исправлено | **Да** (P2-1, P2-2, P2-3) |
| Тесты проходят | **Да — 208/208 в 39 файлах** (было 175/31; +33 теста, +8 файлов) |
| typecheck / build backend / build web | **Да / Да / Да** |
| Demo readiness | **GO** |
| Pilot readiness | **GO** (при `SERVE_DESIGN=0`, миграциях 0011/0012, ротации токена) |
| Production readiness | **NO-GO** — остаются вне скоупа P0/P1/P2 (финконтур, in-app центр и пр.); см. §4/§6 |

---

## 2. Изменённые файлы

| Файл | Изменение | Причина |
|---|---|---|
| `scripts/_wipe-guard.ts` | **новый** — fail-closed guard | P0-1 |
| `scripts/reset-tenant.ts` | guard + audit за `FORCE_DELETE_AUDIT` + убран хардкод owner id | P0-1 |
| `scripts/clear-requests.ts` | guard + явное удаление детей (cascade убран) | P0-1 / P1-8 |
| `scripts/reset-roles.ts` | guard + убран хардкод owner id | P0-1 |
| `scripts/retry-notifications.ts` | **новый** — повтор доставки failed | P1-6 |
| git remote `origin` | вырезан PAT из URL | P0-2 |
| `README.md` | раздел про токены, destructive-скрипты, бот-скоуп | P0-2 / P1-5 |
| `docs/TELEGRAM_BOT_SCOPE.md` | **новый** — честный объём бота + future tasks | P1-5 |
| `src/db/schema.ts` | 7 FK cascade→restrict; таблица `notifications` | P1-8 / P1-6 |
| `drizzle/0011_restrict_history_deletes.sql` | **новая миграция** | P1-8 |
| `drizzle/0012_notifications.sql` | **новая миграция** | P1-6 |
| `drizzle/meta/_journal.json` | регистрация 0011, 0012 | P1-8 / P1-6 |
| `src/workflow/step-kinds.ts` | `TERMINAL_STATUSES` + `isTerminalStatus()` | P2-1 |
| `src/services/dashboard.service.ts` | терминальные списки из общего источника | P2-1 |
| `src/http/admin.routes.ts` | активация workflow: threshold требует procurement; admin reset-pin | P1-1 / P2-2 |
| `src/services/notification.service.ts` | **новый** — персистенция+доставка+retry+list | P1-6 |
| `src/bot/bot.ts` | `Notifier` → promise (успех/провал доставки) | P1-6 |
| `src/http/routes.ts` | server-side search; PIN-смена; notif-эндпоинты; warehouse scope; терминальность | P1-7/P2-2/P1-6/P2-3 |
| `src/http/compat.routes.ts` | PIN всегда; анти-эскалация; select только на procurement; prod-block | P1-2/3/4 |
| `web/src/api.ts`, `web/src/App.tsx` | серверный поиск + debounce 350ms + total | P1-7 |
| тесты (8 новых файлов) | покрытие всех фиксов | — |

---

## 3. Закрытые задачи

| ID | Статус | Что сделано | Тест добавлен |
|---|---|---|---|
| **P0-1** | ✅ | Общий `assertWipeAllowed`: отказ при `NODE_ENV=production` (и при незаданном), обязательные `FORCE_WIPE=1` + `WIPE_TARGET_DB`=имя БД; audit стирается только по `FORCE_DELETE_AUDIT=1`; хардкод owner-tg удалён | `src/db/wipe-guard.test.ts` (8) |
| **P0-2** | ✅ | Токен вырезан из `git remote` (чистый HTTPS). **Владельцу: отозвать PAT в GitHub → Settings → Developer settings → Tokens.** README: не хранить токены в remote | — (инфра) |
| **P1-1** | ✅ | Активация workflow отклоняется, если amount-gated approval не имеет procurement-шага перед ним; рантайм по конструкции безопасен (procurement фиксирует сумму до порога) | `workflow-threshold-activation.test.ts` (3) |
| **P1-2** | ✅ | Compat approve требует валидный PIN для ЛЮБОЙ роли (была дыра для кастомных ролей) | `compat-hardening.test.ts` |
| **P1-3** | ✅ | Compat назначение роли: анти-эскалация по правам (нельзя выдать роль с правами выше своих) + revoke вместо hard-delete истории | `compat-hardening.test.ts` (2) |
| **P1-4** | ✅ | Compat выбор КП разрешён только на procurement-шаге; иначе `409 REAPPROVAL_REQUIRED` | `compat-hardening.test.ts` (2) |
| **P1-5** | ✅ | Документирован MVP-объём бота; подтверждено: approve невозможен без PIN; future task list | doc + покрыто approve-PIN тестами |
| **P1-6** | ✅ | Таблица `notifications`; строка создаётся ДО отправки; успех→delivered, сбой→failed(+error); retry-функция/скрипт; эндпоинты списка/непрочитанных/read | `notification.service.test.ts` (4) |
| **P1-7** | ✅ | `GET /requests`: search/status/priority/factory/department/requester/date/page — фильтрация в БД + точный `total`; фронт шлёт params с debounce 350ms | `request-search.test.ts` (2) |
| **P1-8** | ✅ | 7 FK (items/history/approvals/signatures/reservations/quotations/attachments) cascade→**restrict**; hard-delete заявки с историей падает; dev-скрипт чистит явно | `cascade-restrict.test.ts` (4) |
| **P2-1** | ✅ | `closed`/`cancelled`/`archived` терминальны везде (dashboard, workflow in-flight, compat override, quote-select) через `TERMINAL_STATUSES` | `dashboard.service.test.ts` (+1) |
| **P2-2** | ✅ | Смена существующего PIN требует старый PIN (+lockout); audit `pin.changed`/`pin.set`; admin reset (`users.manage`+reason+audit+notify, PIN очищается) | `pin-change.test.ts` (2) |
| **P2-3** | ✅ | receive/issue валидируют принадлежность warehouseId и requestId холдингу; join'ы баланса holding-scoped | `warehouse-scope.test.ts` (3) |

**Дополнительно (compat strategy):** в production все мутации compat-слоя отключены (410 `COMPAT_READONLY`) — defense-in-depth поверх точечных фиксов.

---

## 4. Что НЕ закрыто (вне скоупа спринта, осознанно)

| Вопрос | Severity | Почему не закрыто | Рекомендация |
|---|---|---|---|
| Финансовый контур (invoices/payments/partial/сверка/bank_reference) | P1 (функционал) | Крупный новый модуль — вне скоупа «фиксы P0/P1/P2» | Отдельный спринт Finance |
| Documents/OCR, AI, Reports, Budgeting, Desktop UI | P1–P2 | Крупные модули, явно исключены ТЗ | Дорожная карта после пилота |
| Полноценный диалоговый бот (`/link`-коды, `telegram_sessions`, `/cancel`, approve из чата) | P1 | Вне скоупа; MVP задокументирован (P1-5) | Спринт бота |
| In-app центр уведомлений (UI) | P2 | Бэкенд готов (P1-6); UI-экран — отдельно | Добавить экран поверх `GET /me/notifications` |
| Scope-видимость списков по фабрике/отделу | P2 | Осознанная текущая модель (holding-wide для oversight) | Продуктовое решение владельца |
| PIN-lockout in-memory (кластер) | P3 | Не блокер для одного инстанса | Redis при масштабировании |
| `ssl: rejectUnauthorized:false` | P2 | Инфра-настройка Neon | Включить проверку сертификата на проде |
| Frontend `amount_unverified` бейдж | P3 | Бэкенд-инвариант P1-1 уже закрывает обход; UI-нюанс | Добавить бейдж при желании |

---

## 5. Команды проверки (выполнены фактически)

```
npm run typecheck        →  OK (tsc --noEmit, без ошибок)
npm run build            →  OK (tsc -p .)
cd web && npm run build  →  OK (vite build, 340.9 kB / gzip 93.3 kB)
npm test                 →  OK — Test Files 39 passed (39), Tests 208 passed (208), 239.7s
```

**Миграции:** `npm run db:migrate` на dev/staging НЕ выполнялся (нет доступа к БД из этой среды).
Миграции `0011`/`0012` аддитивны и безопасны; тесты применяют их через pglite-мигратор (доказательство —
RESTRICT реально блокирует удаление, а таблица `notifications` работает в тестах).
**На проде обязательно выполнить `npm run db:migrate` до рестарта сервиса.**

---

## 6. Go / No-Go

- **Demo: GO** — golden path и все сценарии зелёные (208 тестов).
- **Pilot: GO** при условиях: `SERVE_DESIGN=0`; применены миграции `0011`/`0012`; PAT отозван владельцем;
  guard-скрипты и demo-сиды не запускаются против прод-БД; финконтур закрыт организационно.
- **Production: NO-GO** — до реализации финансового контура (если он в пилоте) и решения инфра-пунктов
  из §4 (TLS, кластерный lockout, in-app центр). Дыры безопасности из аудита (P0/P1/P2) — **закрыты**.

---

## 7. Рекомендации на следующий спринт

**Перед pilot (быстрое):**
- Отозвать GitHub PAT (действие владельца).
- Прогнать `npm run db:migrate` на staging, сделать бэкап (`deploy/backup.sh`).
- Убедиться, что на проде `SERVE_DESIGN=0` и `NODE_ENV=production`.

**Перед production:**
- Финансовый контур: invoices / payment_requests / payments / partial / сверка счёт↔КП / bank_reference.
- In-app центр уведомлений (UI поверх готового бэкенда P1-6) + email-канал.
- TLS `rejectUnauthorized:true`; вынести PIN-lockout/rate-limit в Redis; CSP в nginx; offsite-бэкап.
- Audit immutability на уровне БД (REVOKE/триггер), заполнять device/ip/роль-актёра.

**Позже (полный Factory OS):**
- Documents/OCR, AI-модули, Reports, Budgeting, Desktop Dashboard (Sidebar/Topbar/UniversalTable),
  диалоговый Telegram-бот (linking-коды, FSM, approve из чата), резервирование склада,
  delegate/changes_requested в согласовании.

---

*Все изменения — на ветке `fix/audit-p0-p1-p2-2026-07-02`, в рабочем дереве (коммит не делался — по вашему слову закоммичу/запушу). Существующие тесты не отключались; 33 новых теста падали бы до фиксов.*
