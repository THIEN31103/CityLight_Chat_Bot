#!/usr/bin/env bash
# Runs every time the codespace starts (devcontainer.json postStartCommand), and by hand: bash .devcontainer/start.sh
# Starts the containers, then each service in the background with its log in ~/.citylight/logs.
# A service already running is left alone. Stop everything: bash .devcontainer/stop.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK=/workspaces/citylight
VOICE="$HOME/jarvis-voice"
LOGS="$HOME/.citylight/logs"
RUN="$HOME/.citylight/run"
mkdir -p "$LOGS" "$RUN"

if [ ! -f "$STACK/.env" ]; then
  echo "[start] Chưa cài đặt xong (thiếu $STACK/.env). Chạy: bash .devcontainer/setup.sh"
  exit 0
fi

for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
(cd "$STACK" && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d) >"$LOGS/docker.log" 2>&1
for c in citylight-db citylight-redis citylight-emqx; do
  for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] && break; sleep 2; done
done

# run NAME DIR COMMAND...: background, log to $LOGS/NAME.log, pid in $RUN/NAME.pid
run() {
  local name=$1 dir=$2; shift 2
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "[start] $name đang chạy"; return; fi
  (cd "$dir" && nohup setsid "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$RUN/$name.pid")
  echo "[start] $name (log: $LOGS/$name.log)"
}

run api      "$STACK/apps/api"       node --env-file=../../.env --import tsx src/main.ts
sleep 5
run ingest   "$STACK/apps/workers"   node --env-file=../../.env --import tsx src/ingest.ts
run command  "$STACK/apps/workers"   node --env-file=../../.env --import tsx src/command-worker.ts
# 65 connected cabinets: at least 2 in every district (2026-11-21); the other 935 stay offline
run sim      "$STACK/apps/simulator" node --env-file=../../infra/.env --import tsx src/index.ts --count 65
# Vite refuses unknown host names: allow the Codespaces forwarding domain
run web      "$STACK"                env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.app.github.dev npm run dev:web:hybrid
run voice    "$ROOT/apps/jarvis"     env PYTHONIOENCODING=utf-8 STT_MODEL=none TTS_ENGINE=piper PIPER_VOICE="$VOICE/piper/vi_VN-vais1000-medium.onnx" "$VOICE/venv/bin/python" -u voice/sidecar.py
run jarvis   "$ROOT/apps/jarvis"     node --env-file-if-exists=.env --disable-warning=ExperimentalWarning --import tsx src/main.ts

echo
echo "[start] Web CityLight: cổng 5173 · Jarvis: cổng 8790 (tab PORTS của Codespaces). Đăng nhập: admin@citylight.test"
