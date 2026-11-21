#!/usr/bin/env bash
# Stops every service started by start.sh and the containers (the data stays). Start again: bash .devcontainer/start.sh
set -uo pipefail
RUN="$HOME/.citylight/run"
for f in "$RUN"/*.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  rm -f "$f"
  echo "[stop] $(basename "$f" .pid)"
done
(cd /workspaces/citylight 2>/dev/null && docker compose -f infra/docker-compose.yml --env-file infra/.env stop) || true
