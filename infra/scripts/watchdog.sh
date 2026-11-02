#!/bin/sh
# VPS watchdog (M11): checks the stack every 5 min and tells the admins on Telegram when something breaks,
# again every REPEAT_MIN while it stays broken, and once when it recovers. Cannot report the VPS itself being
# down: that is the external uptime monitor's job (see README, VPS line).
# cron: */5 * * * * sh /opt/citylight/infra/scripts/watchdog.sh >> /opt/citylight/backups/watchdog.log 2>&1
#   watchdog.sh --test   send a test message and print the checks
# Trial stack (S60): trial-ctl.sh watchdog sets the variables below: trial containers / database / Redis / backups,
# the customer broker over WireGuard (MQTT_CHECK=10.88.0.2:1885), and the alerts go to the production bot and admins
# (ALERT_*), prefixed with LABEL.
set -u
ROOT=${ROOT:-/opt/citylight}
ENV_FILE=${ENV_FILE:-$ROOT/infra/.env}
STATE=${STATE:-/var/tmp/citylight-watchdog.state}
CHATS_CACHE=${CHATS_CACHE:-$ROOT/infra/.watchdog-chats}
REPEAT_MIN=${REPEAT_MIN:-60}
DISK_MAX=${DISK_MAX:-85}
BACKUP_MAX_H=${BACKUP_MAX_H:-26}
QUIET_MIN=${QUIET_MIN:-15}
BROKER_DOWN_MIN=${BROKER_DOWN_MIN:-5}
CONTAINER_PREFIX=${CONTAINER_PREFIX:-citylight-}
CONTAINERS=${CONTAINERS:-"db redis emqx api ingest command scheduler notify caddy"}
DB_CONTAINER=${DB_CONTAINER:-citylight-db}
REDIS_CONTAINER=${REDIS_CONTAINER:-citylight-redis}
MQTT_CHECK=${MQTT_CHECK:-127.0.0.1:1883}
BACKUP_DIR=${BACKUP_DIR:-$ROOT/backups}
ALERT_ENV_FILE=${ALERT_ENV_FILE:-$ENV_FILE}
ALERT_DB_CONTAINER=${ALERT_DB_CONTAINER:-$DB_CONTAINER}
LABEL=${LABEL:-CityLight server}

envv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$ALERT_ENV_FILE" | tail -1 | cut -d= -f2-)
SITE=$(envv SITE_HOST)
SQL() { docker exec "$DB_CONTAINER" psql -U citylight -d citylight -tAc "$1" 2>/dev/null; }

problems=""
add() { problems="${problems}- $1
"; }

for c in $CONTAINERS; do
  s=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$CONTAINER_PREFIX$c" 2>/dev/null || echo missing)
  case "$s" in running|running/healthy) ;; *) add "container $c: $s" ;; esac
done

h=$(curl -s -m 10 "https://$SITE/api/v1/health" 2>/dev/null)
echo "$h" | grep -q '"status":"ok"' || add "API health: ${h:-no answer}"

MQTT_HOST=${MQTT_CHECK%:*}; MQTT_PORT=${MQTT_CHECK##*:}
timeout 5 sh -c "exec 3<>/dev/tcp/$MQTT_HOST/$MQTT_PORT" 2>/dev/null || \
  (command -v nc >/dev/null && nc -z -w 5 "$MQTT_HOST" "$MQTT_PORT" 2>/dev/null) || add "MQTT $MQTT_CHECK does not accept connections"

disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "$disk" -ge "$DISK_MAX" ] && add "disk / ${disk}% (limit ${DISK_MAX}%)"

newest=$(ls -t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | head -1)
if [ -z "$newest" ]; then add "no backup file"; else
  age_h=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
  [ "$age_h" -ge "$BACKUP_MAX_H" ] && add "newest backup is ${age_h} h old ($(basename "$newest"))"
fi
# encryption configured (S46): the laptop only pulls .age copies, so a stale one means no fresh off-VPS backup
if [ -s "$ROOT/infra/backup-recipients.txt" ]; then
  newest_enc=$(ls -t "$BACKUP_DIR"/db-*.sql.gz.age 2>/dev/null | head -1)
  if [ -z "$newest_enc" ]; then add "no encrypted backup (.age): is age installed?"; else
    age_h=$(( ($(date +%s) - $(stat -c %Y "$newest_enc")) / 3600 ))
    [ "$age_h" -ge "$BACKUP_MAX_H" ] && add "newest encrypted backup is ${age_h} h old ($(basename "$newest_enc"))"
  fi
fi

# registered cabinets but no frame at all for QUIET_MIN: broker or ingest is stuck (one offline cabinet is an alarm, not this).
# telemetry, not frames_raw: since S57 frames_raw keeps only 1 frame per cabinet per 10 min
reg=$(SQL "SELECT count(*) FROM cabinets WHERE active")
if [ "${reg:-0}" -gt 0 ]; then
  recent=$(SQL "SELECT count(*) FROM telemetry WHERE ts > now() - interval '$QUIET_MIN minutes'")
  [ "${recent:-0}" -eq 0 ] && add "no MQTT frame from any of $reg cabinets for $QUIET_MIN min"
fi

# ingest <-> broker link (written by ingest every 30 s, cl:ingest:mqtt): while it is down ingest pauses the offline
# checks, so this single message replaces one E101 per cabinet
link=$(docker exec "$REDIS_CONTAINER" redis-cli -a "$(envv REDIS_PASSWORD)" --no-auth-warning GET cl:ingest:mqtt 2>/dev/null)
field() { echo "$link" | grep -o "\"$1\":[^,}]*" | cut -d: -f2- | tr -d '"'; }
if [ -z "$link" ]; then
  add "ingest has never reported its broker link (cl:ingest:mqtt missing)"
else
  at=$(date -d "$(field at)" +%s 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - at )) -gt 180 ]; then
    add "ingest stopped reporting its broker link $(( ($(date +%s) - at) / 60 )) min ago: ingest stuck?"
  elif [ "$(field connected)" = false ]; then
    since=$(date -d "$(field since)" +%s 2>/dev/null || date +%s)
    down_min=$(( ($(date +%s) - since) / 60 ))
    [ "$down_min" -ge "$BROKER_DOWN_MIN" ] && add "ingest lost the MQTT broker ${down_min} min ago: cabinet status is frozen (no offline alarms meanwhile)"
  fi
fi

end=$(echo | timeout 10 openssl s_client -connect "$SITE:443" -servername "$SITE" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  [ "$days" -lt 14 ] && add "HTTPS certificate expires in $days days"
fi

# recipients: admins who linked Telegram; cached for when the database itself is down
chats=$(docker exec "$ALERT_DB_CONTAINER" psql -U citylight -d citylight -tAc "SELECT DISTINCT s.address FROM notification_subscriptions s JOIN users u ON u.id = s.user_id
             WHERE s.channel = 'telegram' AND s.enabled AND u.active AND u.role = 'admin'" 2>/dev/null)
if [ -n "$chats" ]; then echo "$chats" > "$CHATS_CACHE"; elif [ -f "$CHATS_CACHE" ]; then chats=$(cat "$CHATS_CACHE"); fi

send() {
  [ -n "$TOKEN" ] && [ -n "$chats" ] || { echo "$(date -Is) no Telegram token or no linked admin: $1"; return; }
  for id in $chats; do
    curl -s -m 20 -o /dev/null -w "" "https://api.telegram.org/bot$TOKEN/sendMessage" \
      --data-urlencode "chat_id=$id" --data-urlencode "text=$1" --data-urlencode "disable_web_page_preview=true" \
      || echo "$(date -Is) telegram send failed to $id"
  done
}

now=$(date +%s)
sig=$(printf '%s' "$problems" | md5sum | cut -c1-12)
prev_sig=""; last_sent=0
[ -f "$STATE" ] && read -r prev_sig last_sent < "$STATE"

if [ "${1:-}" = "--test" ]; then
  echo "checks: ${problems:-all ok}"; echo "recipients: $(echo $chats)"
  send "✅ $LABEL watchdog test ($(hostname), $(date '+%H:%M %d/%m')). Checks: ${problems:-all ok}"
  exit 0
fi

if [ -n "$problems" ]; then
  if [ "$sig" != "$prev_sig" ] || [ $(( now - last_sent )) -ge $(( REPEAT_MIN * 60 )) ]; then
    send "🚨 $LABEL ($SITE) $(date '+%H:%M %d/%m'):
$problems"
    echo "$(date -Is) ALERT $sig: $(echo "$problems" | tr '\n' ' ')"
    echo "$sig $now" > "$STATE"
  fi
elif [ -n "$prev_sig" ] && [ "$prev_sig" != "$(printf '' | md5sum | cut -c1-12)" ]; then
  send "✅ $LABEL ($SITE): back to normal at $(date '+%H:%M %d/%m')."
  echo "$(date -Is) RECOVERED"
  echo "$sig $now" > "$STATE"
fi
exit 0
