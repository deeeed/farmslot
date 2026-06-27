#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SCRIPT_DIR/agentic.conf"

echo "[preflight] Checking Metro on port $METRO_PORT..."
if lsof -i ":$METRO_PORT" -sTCP:LISTEN -t &>/dev/null; then
  echo "[preflight] Metro already running on port $METRO_PORT"
else
  echo "[preflight] Starting Metro on port $METRO_PORT..."
  # Use yarn (package manager pinned in package.json). Never npx — it can regenerate package-lock.json.
  cd "$APP_DIR" && yarn start &
  sleep 5
fi

echo "[preflight] Checking gateway..."
if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" &>/dev/null; then
  echo "[preflight] Gateway reachable on :${GATEWAY_PORT}"
else
  echo "[preflight] WARNING: Gateway not reachable on :${GATEWAY_PORT}"
fi

echo "[preflight] Done"
