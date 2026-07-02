# Sprint — Notification Center UI (plan-doc, БЕЗ кода)

Статус: **черновик на согласование**. Реализация — только после утверждения scope.
Принцип (как в Dashboard MVP): показываем только то, что реально отдаёт backend. Никаких fake-состояний.

Бэкенд уведомлений уже есть (P1-6). Эта задача — **только frontend-экран** поверх готовых API + бейдж.

---

## 0. Факты backend (из чего исходим)

**Эндпоинты (все — только свои уведомления, backend фильтрует по `recipient_user_id`):**
- `GET /api/me/notifications` → `{ items: Notification[], unread: number }`; `?unread=1` — только непрочитанные.
- `GET /api/me/notifications/unread-count` → `{ unread: number }`.
- `POST /api/me/notifications/:id/read` → `{ ok }` (только свой; чужой → 404).
- `POST /api/me/notifications/read-all` → `{ ok, count }`.

**Модель статусов** (одно поле `status`): `pending` (создано, ещё не доставлено — транзиентно) · `delivered` (доставлено = **непрочитано**) · `read` (прочитано) · `failed` (доставка не удалась, есть `error_message`).
→ «unread» — это `status='delivered'`. `unread-count` считает именно `delivered`.

**Поля Notification (что можно показать):** `id`, `title`, `message`, `priority` (low/normal/high/urgent/critical), `status`, `error_message`, `entity_type`, `entity_id`, `action_url`, `action_buttons`, `created_at`, `delivered_at`, `read_at`, `expires_at`.

**Важные ограничения (честно):**
- **Retry failed — нет HTTP-эндпоинта.** Есть только функция `retryFailedNotifications` + `scripts/retry-notifications.ts` (оператор запускает вручную). Значит «retry в UI» **вне MVP** — потребует нового endpoint (отдельная backend-задача).
- **`action_buttons`/`action_url` сейчас всегда пустые** — ни один продюсер их не заполняет. Значит action-кнопок в уведомлениях пока не существует; UI их не показывает (или показывает только если появятся).
- **entity_type/entity_id заполняются** (`request` + id, `user` + id) → переход в заявку работает для `entity_type='request'`.

---

## 1. Что показываем на экране уведомлений

Список своих уведомлений (newest first), каждая карточка:
- **Заголовок** (`title`) + **текст** (`message`).
- **Статус-бейдж:** Непрочитано (`delivered`) / Прочитано (`read`) / Ошибка доставки (`failed`). `pending` — редко/кратко, показываем как «отправляется».
- **Приоритет** — визуальный акцент для `high/urgent/critical` (цвет/иконка), без отдельного текста.
- **Переход в заявку:** если `entity_type='request'` → тап по карточке открывает Request Detail (`entity_id`). Для `entity_type='user'` (напр. сброс PIN) перехода нет — карточка информационная.
- **Failed-состояние:** явный текст «Не доставлено» + `error_message` (напр. «recipient has no telegram id»). Без кнопки retry (нет API) — но текст понятный.
- **Время:** `created_at` всегда; `delivered_at` и `read_at` — в развёрнутом виде/подписи, если заданы.
- **Action buttons:** показываем, только если `action_buttons` непустой (сейчас всегда пусто → секции нет).

Соответствие терминам из ТЗ: unread = `delivered`; read = `read`; delivered = тот же `delivered`; failed = `failed`. (В нашей модели delivered и unread — одно и то же состояние.)

---

## 2. Какие роли что видят

- **Обычный пользователь** — только свои уведомления (backend enforce).
- **Director / Owner / Auditor** — тоже **только свои**, НЕ весь холдинг (backend сейчас так устроен: фильтр по `recipient_user_id`). Holding-wide admin-центр — вне scope.
- **Retry failed** — **не в MVP**: HTTP-эндпоинта нет, право проверять негде. Когда/если появится endpoint — гейтить отдельным правом (напр. `settings.manage` или новым `notifications.retry`).

Вывод: экран одинаков для всех ролей по составу (свои уведомления); отличий по ролям в MVP нет.

---

## 3. Какие API уже есть

| Нужно | Endpoint | Есть? |
|---|---|---|
| Список уведомлений (свои) | `GET /me/notifications` (+`?unread=1`) | ✅ |
| Счётчик непрочитанных | `GET /me/notifications/unread-count` | ✅ |
| Отметить одно прочитанным | `POST /me/notifications/:id/read` | ✅ |
| Отметить все прочитанными | `POST /me/notifications/read-all` | ✅ |
| Retry failed | — | ❌ только скрипт/функция (вне MVP) |

Новых эндпоинтов для MVP **не требуется**. (`GET /me/notifications` уже возвращает всё нужное, включая failed и таймстемпы.)

---

## 4. Что нужно на frontend

- **Точка входа:** кнопка-колокол в шапке (header) с **бейджем unread count**. Рекомендую колокол в topbar, а не новый таб в BottomNav (там уже до 7 табов — тесно). *(см. открытый вопрос 1)*
- **Экран Notifications:**
  - список карточек (§1) с loading / empty / error состояниями;
  - фильтр **Все / Непрочитанные** (простой; сложных фильтров нет);
  - **mark one as read** — тап/кнопка на карточке (`POST /:id/read`), UI обновляет статус;
  - **mark all as read** — кнопка в шапке экрана (`POST /read-all`), обновляет бейдж;
  - **переход в заявку** из карточки (`entity_type='request'` → Request Detail);
  - **failed-карточка** — понятный текст + `error_message`, без retry-кнопки (нет API);
  - при открытии заявки из непрочитанного — опционально помечать как read.
- **Badge unread count:** источник — `GET /me/notifications/unread-count` (Home v2 уже его дёргает для KPI). Колокол переиспользует то же значение; обновлять после mark-read/read-all.
- **Роутинг:** через screen-state (URL-роутера нет), новый `Screen`-вариант `{ name: 'notifications' }`.

---

## 5. Что НЕ входит в MVP

- **Retry failed из UI** (нет HTTP-эндпоинта — отдельная backend-задача).
- Email / SMS / push вне Telegram.
- Notification preferences (настройки каналов/подписок).
- Holding-wide admin notification center (видеть чужие уведомления).
- Сложные фильтры (по типу/приоритету/датам), поиск.
- AI-alerts, эскалации, группировка/threading.
- Action buttons внутри уведомления (продюсеров нет; появятся — добавим отдельно).
- Пагинация «бесконечная» — MVP берёт разумный лимит (напр. 50, backend уже лимитирует).

---

## 6. Порядок после согласования scope

1. **Frontend screen** Notifications + колокол с бейджем + состояния (loading/empty/error) + mark read / mark all read + переход в заявку + failed-текст.
2. **Tests** — пока фронт-тестов в проекте нет; проверяем через типизацию/сборку и **manual QA** (§ниже). Если решим — добавить лёгкий тест на маппинг статусов (unit) — по согласованию.
3. **Manual QA:** создать уведомления разных статусов (delivered/read/failed через staging или seed), проверить бейдж, mark read, mark all, переход в заявку, failed-текст, empty/error.
4. **Gates:** `npm run typecheck` · `npm test` · `npm run build` · `cd web && npm run build` → PR → зелёный CI → merge.

---

## Открытые вопросы к согласованию

1. **Точка входа:** колокол в header с бейджем (рекомендую) — или отдельный таб в BottomNav, или пункт в «Меню»?
2. **Фильтр:** оставляем «Все / Непрочитанные» — или в MVP хватит одной ленты «Все» с бейджами статусов?
3. **Failed без retry:** ок показать failed только как статус+текст (retry позже, когда добавим endpoint)? Или включить маленькую backend-задачу «`POST /me/notifications/:id/retry`» в этот же sprint (тогда scope растёт на backend+тест)?
4. **Авто-mark-read** при открытии заявки из уведомления — включаем или только явная отметка?

После ответов зафиксирую финальный scope, затем — реализация по §6.
