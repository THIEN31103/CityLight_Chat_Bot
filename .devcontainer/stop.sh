#!/usr/bin/env bash
# Stops every service started by start.sh and the containers (the data stays). Start again: bash .devcontainer/start.sh
# Services are found by their command line, not by pid files (those were not reliable, 2026-11-23).
set -uo pipefail
for p in 'src/ingest.ts' 'src/command-worker.ts' 'src/index.ts --count' 'dev:web:hybrid' 'vite --mode hybrid' 'voice/sidecar.py' 'tsx src/main.ts'; do
  pkill -f -- "$p" && echo "[stop] $p"
done
rm -rf "$HOME/.citylight/run"
(cd /workspaces/citylight 2>/dev/null && docker compose -f infra/docker-compose.yml --env-file infra/.env stop) || true
