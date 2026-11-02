#!/bin/sh
# Daily VPS backup (M11): database dump + incident photos, kept KEEP_DAYS days in BACKUP_DIR.
# cron: 15 2 * * * sh /opt/citylight/infra/scripts/backup-db.sh >> /opt/citylight/backups/backup.log 2>&1
# Restore (TimescaleDB: into an empty database, wrapped in pre/post restore; drill: restore-drill.sh, full steps docs/runbook.md):
#   docker exec citylight-db psql -U citylight -d citylight -c 'SELECT timescaledb_pre_restore()'
#   gunzip -c db-<ts>.sql.gz | docker exec -i citylight-db psql -U citylight -d citylight
#   docker exec citylight-db psql -U citylight -d citylight -c 'SELECT timescaledb_post_restore()'
# Encryption (A7, S46): with AGE_RECIPIENTS present (public keys, one per line), each file also gets an age-encrypted
# copy <file>.age. Only the .age copies leave the VPS (pull-backups.ps1); the plain files stay here for restore-drill
# and a fast restore (whoever owns the VPS already has the live database). The private key is never on the VPS.
# Off-VPS copy: pulled daily by the laptop (pull-backups.ps1, Task Scheduler "CityLight backup pull").
# S57: the rows of telemetry (every frame, 30 days) and frames_raw (debug, 7 days) are left out: their chunks are
# dumped empty, history survives in the telemetry_5m / 1h / 1d aggregates. After a restore the cabinet charts of the
# last days are empty until new frames arrive. FULL=1 dumps everything (before a migration that rewrites them).
set -euf # -f: the pg_dump patterns below contain '*'
BACKUP_DIR=${BACKUP_DIR:-/opt/citylight/backups}
KEEP_DAYS=${KEEP_DAYS:-14}
AGE_RECIPIENTS=${AGE_RECIPIENTS:-/opt/citylight/infra/backup-recipients.txt}
FULL=${FULL:-0}
# trial stack (S60, trial-ctl.sh): DB_CONTAINER=citylight-trial-db UPLOADS_VOLUME=citylight-trial_uploads BACKUP_DIR=...-trial
DB_CONTAINER=${DB_CONTAINER:-citylight-db}
UPLOADS_VOLUME=${UPLOADS_VOLUME:-infra_uploads}
LABEL=${LABEL:-backup}
TS=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUP_DIR"

EXCLUDE=""
if [ "$FULL" != 1 ]; then
  # the hypertable itself + its chunks (_hyper_<id>_<n>_chunk and, with compression, _hyper_<id>_<n>_chunk_compressed)
  EXCLUDE=$(docker exec "$DB_CONTAINER" psql -U citylight -d citylight -tAc \
    "SELECT string_agg(format('--exclude-table-data=public.%s --exclude-table-data=_timescaledb_internal._hyper_%s_*', table_name, id), ' ')
     FROM _timescaledb_catalog.hypertable WHERE schema_name = 'public' AND table_name IN ('telemetry', 'frames_raw')")
fi
# shellcheck disable=SC2086 # EXCLUDE is a list of options
docker exec "$DB_CONTAINER" pg_dump -U citylight -d citylight --no-owner $EXCLUDE | gzip > "$BACKUP_DIR/db-$TS.sql.gz.part"
mv "$BACKUP_DIR/db-$TS.sql.gz.part" "$BACKUP_DIR/db-$TS.sql.gz"
docker run --rm -v "$UPLOADS_VOLUME":/u:ro -v "$BACKUP_DIR":/b alpine:3.20 tar czf "/b/uploads-$TS.tar.gz" -C /u .

# <file>.age, written aside then renamed, kept only when it starts with the age header
encrypt() {
  age -R "$AGE_RECIPIENTS" -o "$1.age.part" "$1" && head -c 21 "$1.age.part" | grep -q 'age-encryption.org/v1' && mv "$1.age.part" "$1.age"
}
if [ -s "$AGE_RECIPIENTS" ]; then
  command -v age >/dev/null 2>&1 || { echo "$(date -Is) $LABEL FAIL: age not installed (sudo apt install age)"; exit 1; }
  if ! encrypt "$BACKUP_DIR/db-$TS.sql.gz" || ! encrypt "$BACKUP_DIR/uploads-$TS.tar.gz"; then
    find "$BACKUP_DIR" -name '*.age.part' -delete
    echo "$(date -Is) $LABEL FAIL: encryption (plain files kept)"
    exit 1
  fi
  ENC=encrypted
else
  ENC="NOT encrypted: no $AGE_RECIPIENTS"
fi

for p in 'db-*.sql.gz' 'uploads-*.tar.gz' 'db-*.sql.gz.age' 'uploads-*.tar.gz.age'; do
  find "$BACKUP_DIR" -name "$p" -mtime +"$KEEP_DAYS" -delete
done
[ "$FULL" = 1 ] && SCOPE=full || SCOPE="without telemetry / frames_raw rows"
echo "$(date -Is) $LABEL ok: db-$TS.sql.gz $(du -h "$BACKUP_DIR/db-$TS.sql.gz" | cut -f1), $SCOPE, $ENC"
