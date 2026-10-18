#!/bin/sh
# Daily VPS backup (M11): database dump + incident photos, kept KEEP_DAYS days in BACKUP_DIR.
# cron: 15 2 * * * /opt/citylight/infra/scripts/backup-db.sh >> /opt/citylight/backups/backup.log 2>&1
# Restore: gunzip -c db-<ts>.sql.gz | docker exec -i citylight-db psql -U citylight -d citylight
set -eu
BACKUP_DIR=${BACKUP_DIR:-/opt/citylight/backups}
KEEP_DAYS=${KEEP_DAYS:-14}
TS=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUP_DIR"

docker exec citylight-db pg_dump -U citylight -d citylight --no-owner | gzip > "$BACKUP_DIR/db-$TS.sql.gz.part"
mv "$BACKUP_DIR/db-$TS.sql.gz.part" "$BACKUP_DIR/db-$TS.sql.gz"
docker run --rm -v infra_uploads:/u:ro -v "$BACKUP_DIR":/b alpine:3.20 tar czf "/b/uploads-$TS.tar.gz" -C /u .

find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: db-$TS.sql.gz $(du -h "$BACKUP_DIR/db-$TS.sql.gz" | cut -f1)"
