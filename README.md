# Factory OS

Telegram-бот + Telegram Mini App + backend для управления заявками, согласованиями, складом и снабжением завода (multi-tenant).

**Стек:** TypeScript / Express · PostgreSQL (Drizzle ORM) · grammY (бот) · React + Vite (Mini App в `web/`).

## ⚠️ Ветки

- **`main` — единственная активная ветка** разработки и деплоя (то, что сейчас на проде). Вся новая работа — только сюда.
- **`master` — устаревшая (legacy).** Для новой работы НЕ использовать и в `main` НЕ мержить (истории веток несвязанные).
- Вложенная папка `factory-os-master/` и скриншоты `photo_*.jpg` в корне — артефакты старого снимка, в рантайме не используются (подлежат удалению).

## Запуск (локально)

Требования: Node 22+, доступ к Postgres (Neon или локальный).

```bash
# 1. backend
npm install
cp .env.example .env          # впиши DATABASE_URL, SESSION_SECRET, PIN_PEPPER
#    для dev-входа локально: NODE_ENV=development и ENABLE_DEV_AUTH=1
npm run db:migrate            # применить миграции
npm run dev                   # API (+ бот) на http://localhost:3100

# 2. Mini App (отдельный терминал)
cd web
npm install
npm run dev
```

## Проверки

```bash
npm run typecheck
npm test
npm run build
cd web && npm run build
```

## Окружение и безопасность

- `NODE_ENV` по умолчанию = **`production`** (fail-closed). Незаданное окружение считается продом.
- Dev-вход (`POST /api/auth/dev`, заголовок `X-Dev-User-Id`) работает **только** при `NODE_ENV=development` **И** `ENABLE_DEV_AUTH=1`.
- На проде: `NODE_ENV=production`, `ENABLE_DEV_AUTH` убрать или `0`. При `production` + `ENABLE_DEV_AUTH=1` приложение **не стартует** — намеренная защита.
- Секреты (`SESSION_SECRET`, `PIN_PEPPER`) ≥16 символов, не плейсхолдеры; в гит не коммитятся.
- `BOT_TOKEN` — только на сервере, никогда во frontend.
- **Токены НЕ хранить в URL git remote.** Используй SSH-ключ или credential helper. Проверка: `git remote -v` не должен содержать `ghp_…`/`github_pat_…`. Если токен когда-либо попадал в remote/историю — **отозвать его в GitHub → Settings → Developer settings → Personal access tokens**, локального удаления недостаточно.

### Опасные (destructive) скрипты

`scripts/reset-tenant.ts`, `scripts/clear-requests.ts`, `scripts/reset-roles.ts` удаляют заявки/пользователей/роли/сток. Они **fail-closed** (`scripts/_wipe-guard.ts`) и откажутся работать, если не выполнено ВСЁ:

```bash
NODE_ENV=development \        # при production (в т.ч. незаданном) — отказ
FORCE_WIPE=1 \               # явный opt-in
WIPE_TARGET_DB=<имя_бд> \    # должно совпасть с БД в DATABASE_URL (защита от опечатки в prod-строке)
OWNER_TG_ID=<tg_id_владельца> \  # для reset-tenant/reset-roles; хардкода прод-id больше нет
  npx tsx scripts/reset-tenant.ts
```

Audit-лог **сохраняется** по умолчанию; чтобы стереть его, добавь `FORCE_DELETE_AUDIT=1` осознанно. **Никогда** не запускай эти скрипты против production-БД.

## Telegram-бот

**MVP scope: уведомления + запуск Mini App.** Полноценный диалоговый бот (linking-коды,
FSM-сессии, approve/создание заявки из чата) пока НЕ реализован. Бот не обходит бизнес-логику:
все действия идут через API Mini App с PIN/permission/audit; согласование невозможно без PIN.
Подробно и список будущих задач — [docs/TELEGRAM_BOT_SCOPE.md](docs/TELEGRAM_BOT_SCOPE.md).

## Пилот-демо

Детерминированный демо-набор для золотого сценария (заявка → согласование директора с PIN → проверка склада → выдача → закрытие):

```bash
npm run seed:pilot   # Holding "Zelal Group", 4 демо-юзера, 2 материала, Pilot Workflow
npm test             # включая e2e golden-path тест
npm run dev          # + cd web && npm run dev
```

Демо-вход (**только dev/staging**: `NODE_ENV=development` + `ENABLE_DEV_AUTH=1`) по Telegram id: `pilot_requester`, `pilot_director`, `pilot_warehouse`, `pilot_admin`. PIN для директора и склада — `1234`.

> ⚠️ **`seed:pilot` запускать только против local/dev/staging БД — НИКОГДА против production.** Под `NODE_ENV=production` команда откажется работать (обход только `FORCE_DEMO_SEED=1`).

Пошаговая проверка: [docs/PILOT_SMOKE_CHECKLIST.md](docs/PILOT_SMOKE_CHECKLIST.md).

## Деплой

VPS + systemd (`factory-os`), HTTPS (Caddy / nginx — см. `deploy/nginx.conf`), Postgres (Neon).
Порядок выката: бэкап БД (`deploy/backup.sh`) → `git tag` → деплой → smoke-тест golden path → откат при сбое.
