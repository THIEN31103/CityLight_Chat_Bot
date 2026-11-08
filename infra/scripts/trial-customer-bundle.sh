#!/bin/sh
# Renders the folder copied to the customer machine (docs/trial.md): docker-compose.yml, README.md, the WireGuard
# template, .env (EMQX
# dashboard password) and emqx/{acl.conf, device-users.csv} from infra/.env.trial. The CSV holds password hashes only.
# Output: infra/customer/out/ (gitignored). Copy: scp -P 2246 -r infra/customer/out cstm@<customer>:citylight-broker
#   sh infra/scripts/trial-customer-bundle.sh
set -eu
ROOT=${ROOT:-/opt/citylight}
ENV_FILE=${ENV_FILE:-$ROOT/infra/.env.trial}
OUT=${OUT:-$ROOT/infra/customer/out}
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE missing: run gen-trial-env.sh first"; exit 1; }
envv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

mkdir -p "$OUT/emqx"
cp "$ROOT/infra/customer/docker-compose.yml" "$ROOT/infra/customer/README.md" "$ROOT/infra/wireguard/wg0-customer.conf.tmpl" \
   "$ROOT/infra/customer/install.sh" "$ROOT/infra/customer/cl-geoip.sh" "$ROOT/infra/customer/cl-geoip.service" \
   "$ROOT/infra/customer/cl-geoip-update.service" "$ROOT/infra/customer/cl-geoip-update.timer" "$OUT/"
if command -v node >/dev/null 2>&1; then
  ENV_FILE="$ENV_FILE" OUT_DIR="$OUT/emqx" CSV_HASH=1 node "$ROOT/infra/scripts/gen-emqx-acl.mjs"
else
  # no node on the VPS host: same image as the stack, paths mapped into the container
  docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT/infra:/app/infra" \
    -e ENV_FILE="/app/infra/${ENV_FILE#"$ROOT/infra/"}" -e OUT_DIR="/app/infra/${OUT#"$ROOT/infra/"}/emqx" -e CSV_HASH=1 \
    citylight-server:dev node /app/infra/scripts/gen-emqx-acl.mjs
fi
(umask 077; printf 'EMQX_DASHBOARD_PASSWORD=%s\n' "$(envv EMQX_DASHBOARD_PASSWORD)" > "$OUT/.env")
echo "bundle ready in $OUT (no clear MQTT password inside; .env = EMQX dashboard password only)"
