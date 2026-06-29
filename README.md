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

## Пилот-демо

Детерминированный демо-набор для золотого сценария (заявка → согласование директора с PIN → проверка склада → выдача → закрытие):

```bash
npm run seed:pilot   # Holding "Zelal Group", 4 демо-юзера, 2 материала, Pilot Workflow
npm test             # включая e2e golden-path тест
npm run dev          # + cd web && npm run dev
```

Демо-вход (**только dev/staging**: `NODE_ENV=development` + `ENABLE_DEV_AUTH=1`) по Telegram id: `pilot_requester`, `pilot_director`, `pilot_warehouse`, `pilot_admin`. PIN для директора и склада — `1234`.

Пошаговая проверка: [docs/PILOT_SMOKE_CHECKLIST.md](docs/PILOT_SMOKE_CHECKLIST.md).

## Деплой

VPS + systemd (`factory-os`), HTTPS (Caddy / nginx — см. `deploy/nginx.conf`), Postgres (Neon).
Порядок выката: бэкап БД (`deploy/backup.sh`) → `git tag` → деплой → smoke-тест golden path → откат при сбое.
