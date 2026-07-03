#!/usr/bin/env bash
# Start command-center dev servers using per-worktree port config.
# Reads .env.ports for port overrides and .env.local-auth for optional local auth secrets.

set -euo pipefail

FARMSLOT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_ENV_FILE="$FARMSLOT_ROOT/.env.ports"
AUTH_ENV_FILE="$FARMSLOT_ROOT/.env.local-auth"

# Load port overrides. Caller-set GATEWAY_PORT/VITE_PORT (sandbox prepare) win over file values.
_gateway_override="${GATEWAY_PORT:-}"
_vite_override="${VITE_PORT:-}"
if [ -f "$PORT_ENV_FILE" ]; then
  set -a; source "$PORT_ENV_FILE"; set +a
  echo "[dev] Loaded ports from $PORT_ENV_FILE"
fi
if [ -n "$_gateway_override" ]; then export GATEWAY_PORT="$_gateway_override"; fi
if [ -n "$_vite_override" ]; then export VITE_PORT="$_vite_override"; fi

# Load optional local-only auth secrets. This file is gitignored and should contain
# FARMSLOT_GATEWAY_TOKEN or FARMSLOT_GATEWAY_PASSWORD when exposing the gateway remotely.
if [ -f "$AUTH_ENV_FILE" ]; then
  set -a; source "$AUTH_ENV_FILE"; set +a
  echo "[dev] Loaded gateway auth from $AUTH_ENV_FILE"
fi

export GATEWAY_PORT="${GATEWAY_PORT:-7777}"
export VITE_PORT="${VITE_PORT:-5174}"
if [ -z "${GATEWAY_HOST:-}" ]; then
  if [ -n "${FARMSLOT_GATEWAY_TOKEN:-}" ] || [ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]; then
    export GATEWAY_HOST=0.0.0.0
  else
    export GATEWAY_HOST=127.0.0.1
  fi
fi
# Dev sessions keep the committed demo pool visible (the documented fastest
# path); installed gateways hide it unless the operator opts in.
export FARMSLOT_DEMO_POOL="${FARMSLOT_DEMO_POOL:-1}"

echo "[dev] Gateway: http://localhost:$GATEWAY_PORT (bind: $GATEWAY_HOST)"
echo "[dev] UI:      http://localhost:$VITE_PORT"
if [ "$GATEWAY_HOST" = "127.0.0.1" ] || [ "$GATEWAY_HOST" = "localhost" ]; then
  echo "[dev] WARN: gateway is loopback-only — Companion LAN QR pairing will fail until GATEWAY_HOST=0.0.0.0"
fi
if [ -n "${FARMSLOT_GATEWAY_TOKEN:-}" ]; then
  echo "[dev] Gateway auth: token"
elif [ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]; then
  echo "[dev] Gateway auth: password"
else
  echo "[dev] Gateway auth: none (loopback-only)"
fi

cd "$FARMSLOT_ROOT/apps/command-center"
exec yarn dev
