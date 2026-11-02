#!/bin/sh
# Restore drill (M11): load a backup into a throw-away TimescaleDB container and compare every table's
# row count with the live database. The live database is only read (counts).
#   infra/scripts/restore-drill.sh [db-YYYYMMDD-HHMM.sql.gz]     (default: newest in BACKUP_DIR)
# Exit 0 = restored without error and every table matches (tables written after the dump may differ: shown, not fatal
# when the restored count is not larger than the live one).
set -eu
BACKUP_DIR=${BACKUP_DIR:-/opt/citylight/backups}
DUMP=${1:-$(ls -t "$BACKUP_DIR"/db-*.sql.gz | head -1)}
[ -f "$DUMP" ] || DUMP="$BACKUP_DIR/$DUMP"
# trial stack (S60, trial-ctl.sh): DB_CONTAINER=citylight-trial-db BACKUP_DIR=...-trial
DB_CONTAINER=${DB_CONTAINER:-citylight-db}
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")
NAME=${DB_CONTAINER%-db}-restore-drill # citylight-restore-drill / citylight-trial-restore-drill

cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "$(date -Is) drill: $DUMP -> $NAME ($IMAGE)"
docker run -d --name "$NAME" --network none \
  -e POSTGRES_USER=citylight -e POSTGRES_DB=citylight -e POSTGRES_PASSWORD="drill-$$" \
  "$IMAGE" >/dev/null
i=0
until docker exec "$NAME" pg_isready -U citylight -d citylight -q 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "drill: temp db did not start"; exit 1; }
  sleep 2
done
sleep 3 # the image restarts postgres once after init

R() { docker exec -i "$NAME" psql -U citylight -d citylight -v ON_ERROR_STOP=1 -q "$@"; }
R -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()' >/dev/null
START=$(date +%s)
gunzip -c "$DUMP" | R >/dev/null
R -c 'SELECT timescaledb_post_restore()' >/dev/null
echo "drill: restore ok in $(( $(date +%s) - START )) s"

TABLES=$(docker exec "$DB_CONTAINER" psql -U citylight -d citylight -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")
bad=0; n=0
# S57: backup-db.sh leaves out the rows of these two (unless FULL=1): only check that the table came back
for t in telemetry frames_raw; do
  rest=$(docker exec "$NAME" psql -U citylight -d citylight -tAc "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo MISSING)
  [ "$rest" = MISSING ] && { bad=$((bad + 1)); echo "  MISSING $t"; } || echo "  skipped $t (rows not in the backup, restored=$rest)"
done
# history lives in the aggregates (views, so not in TABLES): compare them like tables
for t in $TABLES telemetry_5m telemetry_1h telemetry_1d; do
  case "$t" in telemetry|frames_raw) continue ;; esac
  live=$(docker exec "$DB_CONTAINER" psql -U citylight -d citylight -tAc "SELECT count(*) FROM public.\"$t\"")
  rest=$(docker exec "$NAME" psql -U citylight -d citylight -tAc "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo MISSING)
  n=$((n + 1))
  if [ "$live" != "$rest" ]; then
    if [ "$rest" = MISSING ] || [ "$rest" -gt "$live" ]; then bad=$((bad + 1)); echo "  MISMATCH $t live=$live restored=$rest"
    else echo "  newer   $t live=$live restored=$rest (rows written after the dump)"; fi
  fi
done
hyper=$(docker exec "$NAME" psql -U citylight -d citylight -tAc "SELECT count(*) FROM timescaledb_information.hypertables")
echo "drill: $n tables compared, $bad mismatches, $hyper hypertables restored"
[ "$bad" -eq 0 ]
