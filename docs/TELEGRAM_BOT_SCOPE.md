# Telegram Bot — реализованный объём (MVP) и что НЕ сделано

Этот документ фиксирует честный объём Telegram-бота, чтобы не было ложного ожидания «полноценный
диалоговый бот готов». (P1-5 из аудита 2026-07-02.)

## Что бот делает сейчас (MVP)

**Telegram Bot MVP scope: notifications + WebApp launcher.**
**Full conversational bot is not implemented yet.**

- `/start` — приветствие + кнопка «Открыть Factory OS» (Mini App); устанавливает персональное
  меню команд по ролям пользователя.
- `/app`, `/help` — открыть Mini App / помощь.
- Ролевые команды (`/tasks`, `/warehouse`, `/procurement`, `/finance`, `/newrequest`, `/admin`) —
  открывают Mini App (deep-link в конкретный раздел — будущая доработка).
- **Исходящие уведомления** о ключевых событиях заявки (создана, требуется согласование,
  согласовано/отклонено, движение по шагам). С версии P1-6 каждое уведомление **персистится** в
  таблицу `notifications` до отправки; сбой доставки фиксируется (`status='failed'`) и может быть
  повторён (`scripts/retry-notifications.ts`), а не теряется молча.

## Безопасность: бот НЕ обходит бизнес-логику

- Бот **не** выполняет approve/reject/создание заявок/оплату **из чата**. Ни одного обработчика
  callback-кнопок «Согласовать/Отклонить» в боте нет.
- Все бизнес-действия проходят только через API Mini App (canonical `routes.ts`), где действует
  полный набор гарантий: permission + scope + **PIN** + подпись + audit.
- Согласование **невозможно без валидного PIN** (`POST /api/approvals/:id/approve`, а также
  compat-путь после P1-2 требуют PIN для любой роли). PIN вводится в Mini App, не в чате.
- initData Telegram проверяется криптографически (HMAC-SHA256 + `auth_date` ≤ 24 ч, timing-safe).

## Не реализовано (осознанные пробелы; следующий спринт бота)

Диалогового слоя (FSM) и таблицы `telegram_sessions` — нет. Отсутствуют:

- `/link` — привязка аккаунта одноразовым истекающим кодом (сейчас привязка — вводом telegram_id
  админом при инвайте; `telegram_id` уникален на уровне БД).
- `/cancel` — сброс активного диалога; single active flow per user.
- `/status`, `/material`, `/upload`, `/ai`, `/profile` — как диалоговые сценарии.
- Создание заявки и approve **из чата** (с PIN в чате).
- Deep-link ролевых команд в конкретный раздел Mini App.
- In-app центр уведомлений с приоритетами/эскалацией (частично закрыто P1-6: список
  `GET /api/me/notifications`, unread-count, mark-read).

## Здоровье доставки (эксплуатация)

- Неудачные уведомления видны как строки `notifications.status='failed'` с `error_message`.
- Повторная доставка: `npx tsx scripts/retry-notifications.ts` (нужен `BOT_TOKEN`).
- Пользователь видит свои уведомления: `GET /api/me/notifications`,
  `GET /api/me/notifications/unread-count`, `POST /api/me/notifications/:id/read`.
