#!/usr/bin/env bash
# Start command-center dev servers using per-worktree port config.
# Reads .env.ports for port overrides and .env.local-auth for optional local auth secrets.

set -euo pipefail

FARMSLOT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT_ENV_FILE="$FARMSLOT_ROOT/.env.ports"
AUTH_ENV_FILE="$FARMSLOT_ROOT/.env.local-auth"

load_simple_env_file() {
  local file="$1"
  local raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw#"${raw%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    if [[ "$line" != *=* ]]; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi
    if [ "${#value}" -ge 2 ] && { [ "${value:0:1}" = '"' ] || [ "${value:0:1}" = "'" ]; } && [ "${value: -1}" = "${value:0:1}" ]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$file"
}

# Load port overrides. Caller-set GATEWAY_PORT/VITE_PORT (sandbox prepare) win over file values.
_gateway_override="${GATEWAY_PORT:-}"
_vite_override="${VITE_PORT:-}"
if [ -f "$PORT_ENV_FILE" ]; then
  load_simple_env_file "$PORT_ENV_FILE"
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

if [[ ! "${GATEWAY_PORT:-}" =~ ^[0-9]+$ || ! "${VITE_PORT:-}" =~ ^[0-9]+$ ]]; then
  echo "[dev] ERROR: GATEWAY_PORT and VITE_PORT must come from .env.ports or explicit environment values." >&2
  exit 1
fi
export GATEWAY_PORT VITE_PORT
# The dev stack co-launches the local node agent (yarn dev runs it via
# concurrently); point it at this stack's gateway so the machine is not
# NODE DEGRADED (no device feed / file-watch / metrics). MACHINE_NAME
# defaults to the hostname inside the node service. Always derived from
# GATEWAY_PORT — an inherited GATEWAY_URL (e.g. sandbox dev.sh spawned by
# the operator gateway) must not leak the parent stack's address in.
export GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT"

# Fail hard if another gateway already owns the configured port (e.g. a
# `farmslot up` prod stack): the gateway would fail to bind and the
# co-launched node would register onto the OTHER gateway under this
# machine's identity, flapping its node registration.
if (exec 3<>"/dev/tcp/127.0.0.1/$GATEWAY_PORT") 2>/dev/null; then
  echo "[dev] ERROR: port $GATEWAY_PORT is already in use — another gateway (farmslot up?) owns it." >&2
  echo "[dev] Stop it, or set GATEWAY_PORT / .env.ports to a free port." >&2
  exit 1
fi
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
echo "[dev] Node:    $GATEWAY_URL (machine: $(hostname -s))"
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
