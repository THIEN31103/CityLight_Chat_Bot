#!/bin/sh
# Writes infra/.env.trial with fresh random secrets for one customer trial (docs/trial.md). Run once, on the VPS.
# Never overwrites an existing file (the master and the device password are flashed into cabinets). Prints names only.
#   SEED_ADMIN_EMAIL=you@example.com sh infra/scripts/gen-trial-env.sh
set -eu
ROOT=${ROOT:-/opt/citylight}
OUT=${OUT:-$ROOT/infra/.env.trial}
[ -e "$OUT" ] && { echo "$OUT exists: not overwritten"; exit 1; }
[ -n "${SEED_ADMIN_EMAIL:-}" ] || { echo "set SEED_ADMIN_EMAIL (first admin of the trial database)"; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found"; exit 1; }

hex() { openssl rand -hex "$1"; }
# letters / digits only: the device password goes inside a quoted EC25 AT+QMTCONN argument
alnum() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }

umask 077
cat > "$OUT.part" <<EOF
# Generated $(date -Is) by gen-trial-env.sh. Trial stack secrets: never copy to the customer machine
# (it gets only the rendered EMQX files, see trial-customer-bundle.sh).
POSTGRES_USER=citylight
POSTGRES_PASSWORD=$(alnum 32)
POSTGRES_DB=citylight
REDIS_PASSWORD=$(alnum 32)
TOTP_ENC_KEY=$(hex 32)
AUTH_REQUIRE_2FA=true
MQTT_BACKEND_USER=cl-trial-backend-$(hex 12)
MQTT_BACKEND_PASSWORD=$(alnum 32)
TRIAL_MQTT_URL=${TRIAL_MQTT_URL:-mqtt://10.88.0.2:1885}
MQTT_DEVICE_USERNAME=citylight-cab
MQTT_DEVICE_PASSWORD=$(alnum 24)
DEVICE_MASTER_KEY=$(hex 32)
EMQX_DASHBOARD_PASSWORD=$(alnum 24)
SITE_HOST=${SITE_HOST:-trial.13-55-91-187.sslip.io}
TELEGRAM_BOT_TOKEN=
SEED_ADMIN_EMAIL=$SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$(alnum 20)
EOF
# every generated value must be long enough (an empty openssl output would leave a weak secret)
bad=$(grep -E '^(POSTGRES_PASSWORD|REDIS_PASSWORD|MQTT_BACKEND_PASSWORD|MQTT_DEVICE_PASSWORD|EMQX_DASHBOARD_PASSWORD|SEED_ADMIN_PASSWORD)=' "$OUT.part" \
  | awk -F= 'length($2) < 20 { print $1 }')
[ -z "$bad" ] || { rm -f "$OUT.part"; echo "weak value generated for: $bad"; exit 1; }
mv "$OUT.part" "$OUT"
chmod 600 "$OUT"
echo "$OUT written (mode 600): $(grep -E '^[A-Z_]+=' "$OUT" | cut -d= -f1 | tr '\n' ' ')"
echo "Next: copy DEVICE_MASTER_KEY and MQTT_DEVICE_PASSWORD to a safe place outside the VPS (trial firmware build)."
