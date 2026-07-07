# Онбординг разработчика Factory OS

Документ для нового участника: как поднять проект, как он устроен, как ничего не сломать.

## Что это

Factory OS — система заявок и согласований для производственного холдинга, работает как Telegram Mini App. Стек: Node.js + TypeScript + Express, PostgreSQL + Drizzle ORM, React + Vite (мини-апп), grammY (бот), vitest + PGlite (тесты на настоящем Postgres-движке в памяти).

## Быстрый старт локально

```bash
npm ci && (cd web && npm ci)
cp .env.example .env   # если нет examples — см. src/config/env.ts: обязательны DATABASE_URL, SESSION_SECRET (32+), PIN_PEPPER (32+); BOT_TOKEN не нужен для локалки
npm run db:migrate
npm run seed:test      # холдинг «Тестовый завод», 18 пользователей по ролям, PIN у всех 1234
npm run dev            # API на :3000
cd web && npm run dev  # Vite на :5173
```

Вход без Telegram: `NODE_ENV=development` + `ENABLE_DEV_AUTH=1` в `.env`, затем в браузере `/?user=snab_01` (логины — в `docs/TEST_MODE.md`). Каждое окно браузера = свой пользователь (токен в sessionStorage), плюс плавающая DEV-панель переключения ролей.

## Проверки перед любым коммитом

```bash
npx tsc --noEmit && (cd web && npx tsc --noEmit)   # типы
npm test                                            # ~280 тестов, ~6 мин, PGlite
```

Тесты — основной страховочный трос проекта. Правило: **каждый найденный баг превращается в тест**. Есть тесты-инварианты, которые запрещают целые классы багов: `src/workflow/dead-end.test.ts` (шаг без выхода), `src/services/concurrency.test.ts` (двойной сабмит), `src/db/migrations-consistency.test.ts` (журнал ↔ файлы миграций, CRLF).

## Карта кодовой базы

| Путь | Что там |
|---|---|
| `src/workflow/step-kinds.ts` | **Сердце**: реестр видов шагов и их действий (права, флаги, продвижение). Маршрут заявки — это ДАННЫЕ (`workflows`/`workflow_steps`), не код |
| `src/services/lifecycle.service.ts` | Движок: `availableActions` (что можно этому юзеру сейчас), `performAction` (транзакция с FOR UPDATE), inbox |
| `src/http/routes.ts` | Основной API + уведомления о переходах |
| `src/http/request-visibility.ts` | Кто видит заявку и кто видит суммы (`getMoneyVisibility`) — ЕДИНСТВЕННОЕ место правды о видимости |
| `src/rbac/` | Роли/права, `system-roles.ts` — системные роли; холдинги могут иметь кастомные |
| `src/services/notification.service.ts` | Персистентные уведомления: in-app всегда, TG-пуш поверх; `kind` = тип события |
| `src/services/escalation.service.ts`, `digest.service.ts` | Фоновые задачи (тики в `src/server/index.ts`) |
| `drizzle/` | Миграции — обычный SQL + `meta/_journal.json`. Новая миграция = файл + запись в журнал |
| `web/src/App.tsx` | Почти весь мини-апп (экраны), `web/src/admin/` — админка, `web/src/screens/shared.tsx` — общие типы/статусы |
| `docs/TEST_MODE.md` | Логины, матрица ролей и шагов |

## Ключевые принципы (нарушение = баг)

1. **Сервер — источник истины.** Фронт не перефильтровывает данные по правам: если сервер прислал `estimatedAmount: null` — суммы нет; какие кнопки показывать — приходит в `actions` из `availableActions`.
2. **Маршрут — данные.** Не хардкодить последовательности статусов; всё через реестр `step-kinds` и таблицы workflow.
3. **Ничего не исчезает молча.** Каждое действие пишет `request_status_history` + `audit_logs`; согласования подписываются; уведомления сначала сохраняются, потом доставляются.
4. **Fail-closed.** Права проверяются на сервере на каждом действии; dev-вход в проде отвечает stealth-404.
5. **Терминальные статусы** — только через `TERMINAL_STATUSES` из step-kinds (не перечислять руками).

## Окружения

| Что | Где | Особенности |
|---|---|---|
| Прод | `https://138-249-7-204.sslip.io`, VPS, `/opt/factory-os`, systemd `factory-os`, порт 3000 | **НЕ git-репозиторий**, деплой rsync'ом. БД — локальный Postgres. Без согласования владельца прод не трогаем |
| Тестовый стенд | `https://test.138.249.7.204.sslip.io/?user=<логин>` | Клон прода: `/opt/factory-os-test`, сервис `factory-os-test`, порт 3100, БД `factoryos_test`, dev-вход включён, PIN `1234` |

Деплой (проверенная процедура): `git archive HEAD | tar -x` во временную папку → `rsync -az --delete --exclude=.env --exclude=node_modules --exclude=web/node_modules --exclude=backups --exclude=dist --exclude=web/dist` → на сервере `npm ci && npm run build && (cd web && npm ci && npm run build) && npm run db:migrate && systemctl restart <сервис>` → smoke `curl localhost:<порт>/healthz`. Перед прод-деплоем — бэкап БД (`deploy/backup.sh`). Осторожно: CRLF в `deploy/*.sh` на сервере лечится `sed -i 's/\r$//'`.

Сброс стенда свежими данными прода: `bash /opt/factory-os/deploy/reset-test-stand.sh` (на VPS).

## QA-инструменты

- `web/qa/fe-sweep.mjs` — Playwright-обход стенда по 10 ролям: консольные ошибки, упавшие запросы, 5xx, белые экраны, скриншоты (`node qa/fe-sweep.mjs` из `web/`).
- `web/qa/load.mjs` — нагрузочный прогон жизненного цикла через API.
- `npm run seed:test-logins -- "<Холдинг>"` — прикрепить тестовые логины к клону боевых данных.

## Текущее состояние (2026-07-07)

Рабочая ветка — `feat/bugfix-batch-a-visibility` (история QA-циклов в сообщениях коммитов). Открытый бэклог: граф-редактор маршрутов (отложен), пер-пользовательские настройки уведомлений, deep-link кнопки в TG-пушах. Решение владельца: автор заявки итоговую сумму НЕ видит — не «чинить».
