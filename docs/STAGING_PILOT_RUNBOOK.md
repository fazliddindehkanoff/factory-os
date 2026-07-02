# Staging → Limited Pilot — Runbook

Пошаговый чек-лист выката fix-набора (P0/P1/P2 + NEW-2, PR #21) на **staging** и валидации перед limited pilot.

- Выполнять **строго по порядку**, на **staging-сервере** (там, где `/opt/factory-os`) — НЕ на локальной машине.
- Ничего не пропускать. Если шаг упал — см. §12 (Troubleshooting), не идти дальше.
- Подставляй свои значения вместо `<...>`.

> ⚠️ Всё это про **staging**. Никогда не выполнять `db:migrate` / `seed` / destructive-скрипты против production-БД по ошибке.

---

## Предусловия

- Доступ по SSH к staging-серверу.
- `.env` на staging указывает на **staging-БД** (не prod, не локальную).
- Установлены `git`, `node >=22`, `npm`, `pg_dump`, `gzip`.
- `main` содержит смёрженный PR #21 (CI зелёный).

```bash
cd /opt/factory-os
node -v        # ожидать v22.x
git branch --show-current   # обычно main
```

---

## 1. Backup staging DB

```bash
bash deploy/backup.sh
```

Скрипт кладёт дамп в `/opt/factory-os/backups/factory-os_<дата>.sql.gz` (хранит 7 дней).

## 2. Проверка: backup не пустой и это именно staging-БД

```bash
# 2.1 файл создан и весит заметно больше порога (скрипт сам отбраковывает <1KB)
ls -lh backups/ | tail -3

# 2.2 это последний дамп и он непустой
LATEST=$(ls -t backups/factory-os_*.sql.gz | head -1); echo "$LATEST"
test "$(stat -c%s "$LATEST")" -gt 10240 && echo "OK: backup > 10KB" || echo "STOP: backup слишком мал"

# 2.3 бегло убедиться, что внутри реальная схема (а не ошибка)
zcat "$LATEST" | grep -m1 -E "CREATE TABLE|COPY public" && echo "OK: dump содержит схему/данные" || echo "STOP: dump без схемы"

# 2.4 подтвердить, что бэкапилась STAGING-БД (host/dbname без пароля)
grep -E '^DATABASE_URL=' .env | sed -E 's#(://[^:]+:)[^@]*@#\1***@#'
```

**Не продолжать**, если backup мал/пуст или `DATABASE_URL` указывает не на staging.

## 3. Обновить код

```bash
git pull --ff-only
git log -1 --oneline    # ожидать merge PR #21 в истории
```

## 4. Установить зависимости

```bash
npm ci
```

## 5. Применить миграции

```bash
npm run db:migrate
# ожидать в выводе: ✅ migrations applied
```

## 6. Проверка миграций 0011 / 0012

```bash
# journal содержит обе миграции
grep -E "0011_restrict_history_deletes|0012_notifications" drizzle/meta/_journal.json
```

Проверки на самой БД (psql к staging `DATABASE_URL`):

```sql
-- 0012: таблица notifications существует, с нужными колонками и индексами
SELECT to_regclass('public.notifications') AS notifications_table;   -- не NULL
SELECT indexname FROM pg_indexes WHERE tablename = 'notifications';   -- recipient + status idx

-- 0011: FK истории заявок стали RESTRICT (delete_rule = 'RESTRICT')
SELECT tc.table_name, rc.delete_rule
FROM information_schema.referential_constraints rc
JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
WHERE tc.table_name IN
  ('request_items','request_status_history','approvals','signatures','reservations','quotations','attachments')
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name;
-- ожидать delete_rule = 'RESTRICT' для request_id/approval_id FK этих таблиц (не 'CASCADE')
```

**Если `notifications` нет или FK всё ещё CASCADE — STOP**, миграции не легли (см. §12).

## 7. Проверка env

```bash
grep -E '^(NODE_ENV|SERVE_DESIGN|ENABLE_DEV_AUTH)=' .env
```

Ожидать строго:

```
NODE_ENV=production
SERVE_DESIGN=0
ENABLE_DEV_AUTH=0        # или переменная отсутствует
```

Дополнительно: `SESSION_SECRET` и `PIN_PEPPER` ≥16 символов и не плейсхолдеры; `BOT_TOKEN` задан только на сервере. Приложение с `production` + `ENABLE_DEV_AUTH=1` **не стартует** (это защита — так и должно быть).

## 8. Рестарт сервиса (ПОСЛЕ миграций)

```bash
sudo systemctl restart factory-os
sudo systemctl status factory-os --no-pager | head -15
curl -fsS http://127.0.0.1:3000/healthz && echo "  <- healthz OK"
```

## 9. Golden path на staging

Пройти полный жизненный цикл (через Telegram Mini App / бота или API одной заявкой):

```
заявка → согласование с PIN → warehouse check → procurement → добавить КП →
select supplier → approval → finance (mark_paid с PIN) → delivery →
receive goods → issue → close
```

Зафиксировать `REQUEST_ID` созданной заявки для §10. Проверить по ходу:
- на каждом шаге статус меняется ожидаемо (без «сырых» кодов в UI);
- approve/mark_paid требуют PIN; неверный PIN отклоняется;
- выдача уменьшает остаток склада ровно один раз;
- заявка доходит до `closed`.

## 10. SQL-проверки по заявке

```sql
-- 10.1 статусная история — записи по всем пройденным шагам
SELECT new_status, old_status, changed_by, source, created_at
FROM request_status_history
WHERE request_id = '<REQUEST_ID>'
ORDER BY created_at;

-- 10.2 audit-след ключевых действий
SELECT action, module, user_id, source, created_at
FROM audit_logs
WHERE entity_id = '<REQUEST_ID>'
ORDER BY created_at;
-- ожидать среди прочего: request.created, supplier.selected,
-- approval.approved, stock.received, stock.issued (+ mark_paid переход)

-- 10.3 уведомления — есть записи, статусы delivered/failed (не пусто)
SELECT status, title, error_message, created_at
FROM notifications
WHERE entity_id = '<REQUEST_ID>'
ORDER BY created_at;
```

Если часть уведомлений `failed` (например, бот-токен на staging не боевой или получатель не привязан) — это ожидаемо; доставку можно повторить:

```bash
npx tsx scripts/retry-notifications.ts
```

## 11. Критерии GO / NO-GO для limited pilot

**GO** — все пункты выполнены:
- [ ] Backup создан, непустой, снят со staging-БД (§2).
- [ ] `db:migrate` = «✅ migrations applied»; `notifications` есть; FK истории = RESTRICT (§6).
- [ ] env: `NODE_ENV=production`, `SERVE_DESIGN=0`, `ENABLE_DEV_AUTH=0` (§7).
- [ ] Сервис поднялся, `healthz` OK (§8).
- [ ] Golden path пройден до `closed`, PIN обязателен, остаток списан один раз (§9).
- [ ] `request_status_history` покрывает все шаги; `audit_logs` содержит ключевые действия; `notifications` пишутся (§10).

**NO-GO** — если хоть один пункт не выполнен, или проявился любой из стоп-сигналов §12. Тогда — откат (§12) и разбор до повторной попытки.

## 12. Troubleshooting — если миграции или golden path упали

**`db:migrate` упал:**
- Прочитать ошибку. Частые причины: нет доступа к БД (`DATABASE_URL`), TLS, недостаток прав.
- Схема аддитивна и применяется в транзакции драйвером drizzle — частично применённых объектов быть не должно. Проверить §6.
- Повторно запускать миграцию не нужно (migrator не переприменяет уже применённые). Если journal рассинхронизировался — не «чинить руками», а восстановиться из backup (ниже).

**Golden path упал на шаге:**
- Записать: шаг, HTTP-код/ошибку, `REQUEST_ID`.
- Проверить логи: `sudo journalctl -u factory-os -n 200 --no-pager`.
- Сверить env (§7) и что рестарт был **после** миграций (§8).
- Уведомления `failed` сами по себе — не блокер (см. §10 / retry).

**Откат (restore) из backup:**
```bash
# ВНИМАНИЕ: перезапишет данные staging-БД. Только на staging.
LATEST=$(ls -t backups/factory-os_*.sql.gz | head -1)
zcat "$LATEST" | psql "$DATABASE_URL"     # или: sudo -u postgres psql factoryos
sudo systemctl restart factory-os
```

**После любого NO-GO:** не открывать pilot, зафиксировать причину, вернуть staging в рабочее состояние (restore при необходимости), затем повторить runbook с шага 1.

---

## После успешной валидации

Если §11 = GO — **limited pilot можно запускать.**

Дальше — уже не фиксы, а product improvement sprint: pilot dashboard → notification center UI (бэкенд P1-6 готов, нужен экран поверх `GET /me/notifications`) → request detail timeline/blockers → pilot users/roles setup → finance-lite.

Production остаётся **NO-GO** до полноценного finance-контура, documents/OCR, in-app notifications UI, infra hardening и audit immutability.
