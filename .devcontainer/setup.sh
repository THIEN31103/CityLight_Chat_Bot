#!/usr/bin/env bash
# Runs once when the codespace is created (devcontainer.json postCreateCommand). Builds the whole test system:
#   1. CityLight server + web (branch dthien_jarvis_web of this repo) in /workspaces/citylight
#   2. random passwords for the local containers (never in the repo), test admin from a Codespaces secret
#   3. Postgres/TimescaleDB, EMQX, Redis in Docker; tables, base data, 1,000 simulated cabinets
#   4. Jarvis (this branch) + Piper voice (vi_VN-vais1000-medium)
# Safe to run again: every step skips what is already there.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # this checkout (branch dthien_jarvis)
STACK=/workspaces/citylight                # branch dthien_jarvis_web
VOICE="$HOME/jarvis-voice"
STATE="$HOME/.citylight"
mkdir -p "$STATE"
log() { printf '\n\033[1;33m[setup]\033[0m %s\n' "$*"; }
rnd() { openssl rand -hex "${1:-24}"; }

log "1/7 Lấy code CityLight (nhánh dthien_jarvis_web) vào $STACK"
git -C "$ROOT" fetch --quiet origin dthien_jarvis_web
if [ ! -d "$STACK" ]; then git -C "$ROOT" worktree add --detach "$STACK" origin/dthien_jarvis_web; fi

log "2/7 Mật khẩu cho Postgres / Redis / MQTT (ngẫu nhiên, chỉ nằm trong codespace)"
if [ ! -f "$STACK/infra/.env" ]; then
  DB_PW=$(rnd); REDIS_PW=$(rnd); BACKEND="cl-backend-$(rnd 12)"; TOTP=$(rnd 32)
  cat > "$STACK/infra/.env" <<EOF
EMQX_DASHBOARD_PASSWORD=$(rnd 12)
POSTGRES_USER=citylight
POSTGRES_PASSWORD=$DB_PW
POSTGRES_DB=citylight
REDIS_PASSWORD=$REDIS_PW
MQTT_BACKEND_USER=$BACKEND
MQTT_DEVICE_USERNAME=cabinet
MQTT_DEVICE_PASSWORD=$(rnd 16)
TOTP_ENC_KEY=$TOTP
AUTH_REQUIRE_2FA=false
EOF
  ADMIN_PW="${CITYLIGHT_ADMIN_PASSWORD:-}"
  if [ "${#ADMIN_PW}" -lt 12 ]; then
    ADMIN_PW=$(rnd 9)
    printf 'Email: admin@citylight.test\nMật khẩu: %s\n' "$ADMIN_PW" > "$STATE/admin-login.txt"
    chmod 600 "$STATE/admin-login.txt"
    log "Không có secret CITYLIGHT_ADMIN_PASSWORD (>= 12 ký tự): đã tạo mật khẩu ngẫu nhiên trong $STATE/admin-login.txt"
  fi
  # 2FA off: test data only, and the forwarded ports are private to the GitHub account
  cat > "$STACK/.env" <<EOF
DATABASE_URL=postgres://citylight:$DB_PW@localhost:5432/citylight
REDIS_URL=redis://:$REDIS_PW@localhost:6379
MQTT_URL=mqtt://localhost:1885
MQTT_USERNAME=$BACKEND
SEED_ADMIN_EMAIL=admin@citylight.test
SEED_ADMIN_PASSWORD=$ADMIN_PW
TOTP_ENC_KEY=$TOTP
AUTH_REQUIRE_2FA=false
EOF
  chmod 600 "$STACK/infra/.env" "$STACK/.env"
fi

log "3/7 Cài thư viện CityLight (npm ci)"
(cd "$STACK" && npm ci --no-audit --no-fund)

log "4/7 Bật Postgres, EMQX, Redis (Docker)"
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
(cd "$STACK" && npm run infra:up)
for c in citylight-db citylight-redis citylight-emqx; do
  for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] && break; sleep 2; done
done

log "5/7 Tạo bảng, dữ liệu gốc, tài khoản quản trị thử, 1.000 tủ giả lập"
(cd "$STACK/packages/db" && node --env-file=../../.env --import tsx src/migrate.ts)
(cd "$STACK/packages/db" && node --env-file=../../.env --import tsx src/seed.ts)
(cd "$STACK/apps/simulator" && node --env-file=../../.env --import tsx src/register.ts --count 1000)

log "6/7 Jarvis: thư viện + cấu hình (cho phép điều khiển mọi tủ thử)"
(cd "$ROOT" && npm ci --no-audit --no-fund)
CODES=$(docker exec citylight-db psql -U citylight -d citylight -tA -c "select string_agg(code, ',' order by code) from cabinets where active")
# GROQ_API_KEY is NOT written here: Jarvis reads it from the Codespaces secret (an environment variable)
cat > "$ROOT/apps/jarvis/.env" <<EOF
JARVIS_CABINET_ALLOWLIST=$CODES
JARVIS_ACTIONS_ENABLED=true
LLM_PROVIDER=groq
STT_PROVIDER=groq
EOF
if [ -n "${CODESPACE_NAME:-}" ]; then
  JARVIS_URL="https://${CODESPACE_NAME}-8790.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  # the page is served through GitHub's forwarding address: Jarvis accepts requests from it
  echo "JARVIS_EXTRA_ORIGINS=$JARVIS_URL" >> "$ROOT/apps/jarvis/.env"
  # the web's ✦ button opens Jarvis on that address
  echo "VITE_JARVIS_URL=$JARVIS_URL" > "$STACK/apps/web/.env.local"
fi
chmod 600 "$ROOT/apps/jarvis/.env"

log "7/7 Piper (đọc giọng tiếng Việt)"
if [ ! -x "$VOICE/venv/bin/python" ]; then
  sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv >/dev/null
  python3 -m venv "$VOICE/venv"
  "$VOICE/venv/bin/pip" install --quiet --upgrade pip
  "$VOICE/venv/bin/pip" install --quiet piper-tts==1.8.0 numpy
fi
mkdir -p "$VOICE/piper"
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium
for f in vi_VN-vais1000-medium.onnx vi_VN-vais1000-medium.onnx.json; do
  [ -s "$VOICE/piper/$f" ] || curl -fsSL -o "$VOICE/piper/$f" "$BASE/$f"
done

if [ -z "${GROQ_API_KEY:-}" ]; then
  log "CHÚ Ý: chưa có secret GROQ_API_KEY. Jarvis cần nó để trả lời: thêm ở GitHub > Settings > Codespaces > Secrets, rồi khởi động lại codespace."
fi
log "Xong phần cài đặt. start.sh sẽ chạy toàn bộ hệ thống (log ở $STATE/logs)."
