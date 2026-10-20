#!/bin/sh
# Apply MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD from infra/.env to the running EMQX (S43): creates the
# account or changes its password. EMQX only bootstraps device-users.csv for users that do not exist yet, so a
# password change in .env needs this. Talks to the EMQX REST API inside the container (dashboard port is not
# published). Cabinets already connected stay connected; the new password applies to new connections.
#   sh /opt/citylight/infra/scripts/emqx-device-account.sh
set -eu
ROOT=${ROOT:-/opt/citylight}
envv() { grep -E "^$1=" "$ROOT/infra/.env" | tail -1 | cut -d= -f2-; }
U=$(envv MQTT_DEVICE_USERNAME)
P=$(envv MQTT_DEVICE_PASSWORD)
[ -n "$U" ] && [ -n "$P" ] || { echo "MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD not set in $ROOT/infra/.env"; exit 1; }
echo "$P" | grep -Eq '^[A-Za-z0-9]{16,64}$' || { echo "password: 16-64 letters / digits"; exit 1; }
# also keep the bootstrap file in step for the next fresh EMQX volume
docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT/infra:/app/infra" citylight-server:dev node /app/infra/scripts/gen-emqx-acl.mjs >/dev/null

docker exec -e U="$U" -e P="$P" citylight-emqx sh -c '
  API=http://localhost:18083/api/v5
  T=$(curl -sf -X POST $API/login -H content-type:application/json \
        -d "{\"username\":\"admin\",\"password\":\"$EMQX_DASHBOARD__DEFAULT_PASSWORD\"}" | sed -E "s/.*\"token\":\"([^\"]+)\".*/\1/")
  [ -n "$T" ] || { echo "EMQX API login failed"; exit 1; }
  BASE=$API/authentication/password_based:built_in_database/users
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/$U" -H "Authorization: Bearer $T" -H content-type:application/json \
           -d "{\"password\":\"$P\",\"is_superuser\":false}")
  if [ "$code" = 404 ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE" -H "Authorization: Bearer $T" -H content-type:application/json \
             -d "{\"user_id\":\"$U\",\"password\":\"$P\",\"is_superuser\":false}")
    echo "device account $U created ($code)"
  else
    echo "device account $U password set ($code)"
  fi
  case $code in 2*) ;; *) exit 1 ;; esac'
