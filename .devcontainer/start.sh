#!/usr/bin/env bash
# Runs every time the codespace starts (devcontainer.json postStartCommand), and by hand: bash .devcontainer/start.sh
# Starts the containers, then each service in the background with its log in ~/.citylight/logs.
# A service already running is left alone. Stop everything: bash .devcontainer/stop.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK=/workspaces/citylight
VOICE="$HOME/jarvis-voice"
LOGS="$HOME/.citylight/logs"
mkdir -p "$LOGS"

if [ ! -f "$STACK/.env" ]; then
  echo "[start] Chưa cài đặt xong (thiếu $STACK/.env). Chạy: bash .devcontainer/setup.sh"
  exit 0
fi

for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
(cd "$STACK" && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d) >"$LOGS/docker.log" 2>&1
for c in citylight-db citylight-redis citylight-emqx; do
  for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] && break; sleep 2; done
done

# running CHECK: "port:NNNN" = something listens there; "proc:TEXT" = a process whose command line has TEXT.
# (A pid file was not reliable: the saved pid was a short-lived shell, so a running Jarvis looked stopped and a
# second copy failed on its port, 2026-11-23.)
running() {
  case $1 in
    port:*) ss -ltn "sport = :${1#port:}" | grep -q LISTEN ;;
    proc:*) pgrep -f -- "${1#proc:}" >/dev/null ;;
  esac
}
# run NAME CHECK DIR COMMAND...: start in the background unless already running, log to $LOGS/NAME.log
run() {
  local name=$1 check=$2 dir=$3; shift 3
  if running "$check"; then echo "[start] $name đang chạy"; return; fi
  (cd "$dir" && exec nohup setsid "$@" </dev/null >"$LOGS/$name.log" 2>&1) &
  echo "[start] $name (log: $LOGS/$name.log)"
}

run api     port:3000              "$STACK/apps/api"       node --env-file=../../.env --import tsx src/main.ts
sleep 5
run ingest  proc:src/ingest.ts     "$STACK/apps/workers"   node --env-file=../../.env --import tsx src/ingest.ts
run command proc:src/command-worker.ts "$STACK/apps/workers" node --env-file=../../.env --import tsx src/command-worker.ts
# 65 connected cabinets: at least 2 in every district (2026-11-21); the other 935 stay offline
run sim     "proc:src/index.ts --count" "$STACK/apps/simulator" node --env-file=../../infra/.env --import tsx src/index.ts --count 65
# Vite refuses unknown host names: allow the Codespaces forwarding domain
run web     port:5173              "$STACK"                env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.app.github.dev npm run dev:web:hybrid
run voice   port:8791              "$ROOT/apps/jarvis"     env PYTHONIOENCODING=utf-8 STT_MODEL=none TTS_ENGINE=piper PIPER_VOICE="$VOICE/piper/vi_VN-vais1000-medium.onnx" "$VOICE/venv/bin/python" -u voice/sidecar.py
run jarvis  port:8790              "$ROOT/apps/jarvis"     node --env-file-if-exists=.env --disable-warning=ExperimentalWarning --import tsx src/main.ts

# Wait until the services answer before this script ends: Codespaces cleans up after postStartCommand, and a
# service launched in its last second was gone with it (Jarvis on 2026-11-21, empty log, port 8790 = 502)
up() { for _ in $(seq 1 45); do curl -s -o /dev/null "$1" && return 0; sleep 2; done; return 1; }
for s in "api http://127.0.0.1:3000/api/v1/health" "web http://localhost:5173/" "jarvis http://127.0.0.1:8790/health"; do
  set -- $s
  if up "$2"; then echo "[start] $1: chạy"; else echo "[start] $1: CHƯA CHẠY, xem $LOGS/$1.log"; fi
done

echo
echo "[start] Web CityLight: cổng 5173 · Jarvis: cổng 8790 (tab PORTS của Codespaces). Đăng nhập: admin@citylight.test"
