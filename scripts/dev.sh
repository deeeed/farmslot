#!/usr/bin/env bash
# Start command-center dev servers using per-worktree port config.
# Reads .env.ports for port overrides and .env.local-auth for optional local auth secrets.

set -euo pipefail

DEV_FRAMEWORK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FARMSLOT_ROOT="${FARMSLOT_SLOT_REPO:-$DEV_FRAMEWORK_ROOT}"
PORT_ENV_FILE="$FARMSLOT_ROOT/.env.ports"
AUTH_ENV_FILE="$FARMSLOT_ROOT/.env.local-auth"

load_simple_env_file() {
  local file="$1"
  local keep_existing="${2:-}"
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
    if [ -n "$keep_existing" ] && [ -n "${!key+x}" ]; then
      continue
    fi
    export "$key=$value"
  done < "$file"
}

# Load port overrides. Caller-set GATEWAY_PORT/VITE_PORT (sandbox prepare) win over file values.
_gateway_override="${GATEWAY_PORT:-}"
_vite_override="${VITE_PORT:-}"
_sandbox_home_override="${FARMSLOT_SANDBOX_HOME:-}"
_sandbox_guard_override="${FARMSLOT_SANDBOX_HOME_GUARD:-}"
# Stack ports select an independent auth and bind scope. Clear inherited
# credentials, auth mode and bind host before this checkout loads its files.
source "$DEV_FRAMEWORK_ROOT/scripts/lib/stack-credentials.sh"
clear_inherited_gateway_credentials

if [ -f "$PORT_ENV_FILE" ]; then
  load_simple_env_file "$PORT_ENV_FILE"
  echo "[dev] Loaded ports from $PORT_ENV_FILE"
fi
if [ -n "$_gateway_override" ]; then export GATEWAY_PORT="$_gateway_override"; fi
if [ -n "$_vite_override" ]; then export VITE_PORT="$_vite_override"; fi

# Load optional local-only auth secrets. This file is gitignored and should contain
# FARMSLOT_NODE_TOKEN for the local node; gateway identity lives in its credential store.
if [ -f "$AUTH_ENV_FILE" ]; then
  set -a; source "$AUTH_ENV_FILE"; set +a
  echo "[dev] Loaded gateway auth from $AUTH_ENV_FILE"
fi

# Load the checkout's .env last, non-overriding (shell and the files above win) —
# the same order the CLI's loadCheckoutEnv uses (.env.ports, then .env). The gateway
# resolves execution-template source roots (CONSENSYS_RECIPE_COOK_ROOT,
# PERPS_RECIPE_LIBRARY_ROOT, …) from its own process env, so the dev stack must see
# the checkout .env exactly like `yarn farmslot` already does.
CHECKOUT_ENV_FILE="$FARMSLOT_ROOT/.env"
if [ -f "$CHECKOUT_ENV_FILE" ]; then
  load_simple_env_file "$CHECKOUT_ENV_FILE" keep-existing
  echo "[dev] Loaded checkout env from $CHECKOUT_ENV_FILE"
fi

# Sandbox wrappers select a private home for gateway, node and child clients.
# Checkout files may name the operator home; they cannot override that scope.
if [ -n "$_sandbox_home_override" ]; then
  export FARMSLOT_SANDBOX_HOME="$_sandbox_home_override"
  export FARMSLOT_SANDBOX_HOME_GUARD="$_sandbox_guard_override"
fi
pin_sandbox_home
# Retired gateway env credentials must not reach co-launched clients even when
# an old checkout file still contains them. Gateway identity is store-owned.
unset FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD FARMSLOT_GATEWAY_AUTH_MODE

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
  dev_activated="$(cd "$DEV_FRAMEWORK_ROOT" && node --import tsx --input-type=module -e 'import { CredentialStoreRuntime } from "@farmslot/credential-store"; process.stdout.write(new CredentialStoreRuntime().isActivated() ? "yes" : "no")')"
  if [ "$dev_activated" = yes ]; then
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
  echo "[dev] WARN: gateway is loopback-only — Companion LAN QR pairing needs GATEWAY_HOST=0.0.0.0 in this checkout's .env.ports or .env.local-auth"
fi
echo "[dev] Gateway auth: credential store, solo mode only before activation on loopback"

cd "$FARMSLOT_ROOT/apps/command-center"
exec yarn dev
