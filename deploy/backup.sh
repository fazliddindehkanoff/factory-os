#!/bin/bash
# Factory OS — database backup script
# Run via cron: 0 3 * * * /opt/factory-os/deploy/backup.sh
#
# Requires: pg_dump, gzip
# Stores 7 days of daily backups in /opt/factory-os/backups/

set -euo pipefail

BACKUP_DIR="/opt/factory-os/backups"
KEEP_DAYS=7
MIN_BACKUP_BYTES=1024

# Load DATABASE_URL from .env if not already set
if [ -z "${DATABASE_URL:-}" ]; then
  source /opt/factory-os/.env
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="factory-os_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

echo "[$(date)] Starting backup..."
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$FILEPATH"
else
  sudo -u postgres pg_dump factoryos --no-owner --no-privileges | gzip > "$FILEPATH"
fi

# Verify backup is not empty / suspiciously small
BACKUP_SIZE=$(stat -c%s "$FILEPATH" 2>/dev/null || stat -f%z "$FILEPATH" 2>/dev/null || echo 0)
if [ "$BACKUP_SIZE" -lt "$MIN_BACKUP_BYTES" ]; then
  echo "[$(date)] ERROR: Backup file too small (${BACKUP_SIZE} bytes). Aborting." >&2
  rm -f "$FILEPATH"
  exit 1
fi

echo "[$(date)] Backup saved: $FILEPATH ($(du -h "$FILEPATH" | cut -f1))"

# Cleanup old backups
find "$BACKUP_DIR" -name "factory-os_*.sql.gz" -mtime +${KEEP_DAYS} -delete
echo "[$(date)] Cleaned up backups older than ${KEEP_DAYS} days."
