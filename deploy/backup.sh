#!/bin/bash
# Factory OS — database backup script
# Run via cron: 0 3 * * * /opt/factory-os/deploy/backup.sh
#
# Requires: pg_dump, gzip
# Stores 7 days of daily backups in /opt/factory-os/backups/

set -euo pipefail

BACKUP_DIR="/opt/factory-os/backups"
KEEP_DAYS=7

# Load DATABASE_URL from .env
source /opt/factory-os/.env

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="factory-os_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

echo "[$(date)] Starting backup..."
sudo -u postgres pg_dump factoryos --no-owner --no-privileges | gzip > "$FILEPATH"
echo "[$(date)] Backup saved: $FILEPATH ($(du -h "$FILEPATH" | cut -f1))"

# Cleanup old backups
find "$BACKUP_DIR" -name "factory-os_*.sql.gz" -mtime +${KEEP_DAYS} -delete
echo "[$(date)] Cleaned up backups older than ${KEEP_DAYS} days."
