#!/bin/sh
# Trial stack helper (S60, docs/trial.md). Everything reads infra/.env.trial; production is never touched.
#   sh infra/scripts/trial-ctl.sh up | down | ps | logs [svc] | migrate | seed | seed-region | backup | drill [dump] | watchdog [--test] | bundle
# cron (VPS, user ubuntu):
#   45 2 * * *   sh /opt/citylight/infra/scripts/trial-ctl.sh backup   >> /opt/citylight/backups-trial/backup.log 2>&1
#   */5 * * * *  sh /opt/citylight/infra/scripts/trial-ctl.sh watchdog >> /opt/citylight/backups-trial/watchdog.log 2>&1
# TRIAL_LOCAL=1 adds docker-compose.trial.local.yml (laptop test: ports on 127.0.0.1, broker on the host).
set -eu
ROOT=${ROOT:-/opt/citylight}
ENV_FILE=${ENV_FILE:-$ROOT/infra/.env.trial}
BACKUP_DIR=${BACKUP_DIR:-$ROOT/backups-trial}
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE missing: run gen-trial-env.sh first"; exit 1; }
envv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

dc() {
  if [ "${TRIAL_LOCAL:-0}" = 1 ]; then
    docker compose -f "$ROOT/infra/docker-compose.trial.yml" -f "$ROOT/infra/docker-compose.trial.local.yml" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$ROOT/infra/docker-compose.trial.yml" --env-file "$ENV_FILE" "$@"
  fi
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  up) dc up -d "$@" ;;
  down) dc down ;; # volumes kept; delete the trial data on purpose with: docker compose ... down -v
  ps) dc ps ;;
  logs) dc logs --tail 100 "$@" ;;
  migrate)
    dc up -d trial-db trial-redis
    dc run --rm --no-deps -w /app/packages/db trial-api node --import tsx src/migrate.ts ;;
  seed)
    SEED_ADMIN_EMAIL=$(envv SEED_ADMIN_EMAIL) SEED_ADMIN_PASSWORD=$(envv SEED_ADMIN_PASSWORD) \
      dc run --rm --no-deps -w /app/packages/db -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD trial-api node --import tsx src/seed.ts ;;
  seed-region)
    # S62: area tree = the SERVICE_REGION ward list (trial-api has SERVICE_REGION from the compose file)
    dc run --rm --no-deps -w /app/packages/db trial-api node --import tsx src/seed-region.ts ;;
  backup)
    DB_CONTAINER=citylight-trial-db UPLOADS_VOLUME=citylight-trial_uploads BACKUP_DIR="$BACKUP_DIR" LABEL=trial-backup \
      sh "$ROOT/infra/scripts/backup-db.sh" ;;
  drill)
    DB_CONTAINER=citylight-trial-db BACKUP_DIR="$BACKUP_DIR" sh "$ROOT/infra/scripts/restore-drill.sh" "$@" ;;
  watchdog)
    # broker check = the customer backend listener through WireGuard; alerts through the production bot to its admins
    # (ALERT_ENV_FILE=/dev/null: no token, nothing is sent; --test then only prints the checks)
    url=$(envv TRIAL_MQTT_URL); hostport=${url#*://}
    ENV_FILE="$ENV_FILE" STATE=/var/tmp/citylight-trial-watchdog.state CHATS_CACHE="$ROOT/infra/.watchdog-chats-trial" \
      CONTAINER_PREFIX=citylight-trial- CONTAINERS="db redis api ingest command scheduler notify" \
      DB_CONTAINER=citylight-trial-db REDIS_CONTAINER=citylight-trial-redis MQTT_CHECK="${hostport:-10.88.0.2:1885}" \
      BACKUP_DIR="$BACKUP_DIR" ALERT_ENV_FILE="${ALERT_ENV_FILE:-$ROOT/infra/.env}" ALERT_DB_CONTAINER=citylight-db LABEL="[TRIAL] CityLight" \
      sh "$ROOT/infra/scripts/watchdog.sh" "$@" ;;
  bundle) ENV_FILE="$ENV_FILE" sh "$ROOT/infra/scripts/trial-customer-bundle.sh" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
