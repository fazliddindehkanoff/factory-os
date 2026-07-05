#!/usr/bin/env bash
# Сброс тестового стенда одной командой: factoryos_test пересоздаётся из СВЕЖЕГО
# дампа боевой базы, поверх прикрепляются тестовые dev-логины (/?user=...).
# Запуск НА сервере под root:
#   bash /opt/factory-os/deploy/reset-test-stand.sh ["Имя холдинга"]
# По умолчанию холдинг «Zelal Tekstil». Прод не трогается (только pg_dump).
set -euo pipefail

STAND=/opt/factory-os-test
HOLDING="${1:-Zelal Tekstil}"
DUMP=/tmp/prod_clone_$$.sql
log() { echo "[$(date '+%F %T')] $*"; }

log "Останавливаю сервис стенда"
systemctl stop factory-os-test

log "Свежий дамп прода"
sudo -u postgres pg_dump factoryos --no-owner --no-privileges > "$DUMP"

log "Пересоздаю factoryos_test"
sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS factoryos_test WITH (FORCE)" \
  -c "CREATE DATABASE factoryos_test OWNER factoryos"

DBURL=$(grep -oP 'DATABASE_URL="\K[^"]+' "$STAND/.env")
psql "$DBURL" -q -v ON_ERROR_STOP=1 -f "$DUMP"
rm -f "$DUMP"

log "Прикрепляю тестовые dev-логины к холдингу «$HOLDING»"
cd "$STAND"
sudo -u factory npx tsx src/db/seed-test-logins-cli.ts "$HOLDING"

systemctl start factory-os-test
sleep 3
curl -sf localhost:3100/healthz >/dev/null
log "Готово: стенд = свежий клон прода, dev-логины на месте"
