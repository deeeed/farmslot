#!/usr/bin/env bash
# Start command-center dev servers using per-worktree port config.
# Reads .env.ports for port overrides and .env.local-auth for optional local auth secrets.

set -euo pipefail

FARMSLOT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_ENV_FILE="$FARMSLOT_ROOT/.env.ports"
AUTH_ENV_FILE="$FARMSLOT_ROOT/.env.local-auth"

# Load port overrides
if [ -f "$PORT_ENV_FILE" ]; then
  set -a; source "$PORT_ENV_FILE"; set +a
  echo "[dev] Loaded ports from $PORT_ENV_FILE"
fi

# Load optional local-only auth secrets. This file is gitignored and should contain
# FARMSLOT_GATEWAY_TOKEN or FARMSLOT_GATEWAY_PASSWORD when exposing the gateway remotely.
if [ -f "$AUTH_ENV_FILE" ]; then
  set -a; source "$AUTH_ENV_FILE"; set +a
  echo "[dev] Loaded gateway auth from $AUTH_ENV_FILE"
fi

export GATEWAY_PORT="${GATEWAY_PORT:-7777}"
export VITE_PORT="${VITE_PORT:-5174}"

echo "[dev] Gateway: http://localhost:$GATEWAY_PORT"
echo "[dev] UI:      http://localhost:$VITE_PORT"
if [ -n "${FARMSLOT_GATEWAY_TOKEN:-}" ]; then
  echo "[dev] Gateway auth: token"
elif [ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]; then
  echo "[dev] Gateway auth: password"
else
  echo "[dev] Gateway auth: none (loopback-only)"
fi

cd "$FARMSLOT_ROOT/apps/command-center"
exec yarn dev
