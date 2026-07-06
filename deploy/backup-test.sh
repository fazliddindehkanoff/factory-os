#!/usr/bin/env bash
set -euo pipefail
# Ежедневный дамп тестовой БД factoryos_test (cron 03:30), хранение 7 дней —
# зеркало прод-бэкапа (deploy/backup.sh, 03:00).

BACKUP_DIR=/opt/factory-os-test/backups
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)

sudo -u postgres pg_dump factoryos_test | gzip > "$BACKUP_DIR/factoryos-test_${STAMP}.sql.gz"
find "$BACKUP_DIR" -name 'factoryos-test_*.sql.gz' -mtime +7 -delete

echo "[$(date '+%F %T')] test backup done: factoryos-test_${STAMP}.sql.gz ($(du -h "$BACKUP_DIR/factoryos-test_${STAMP}.sql.gz" | cut -f1))"
