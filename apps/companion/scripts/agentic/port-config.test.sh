#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/agentic.conf"

if GATEWAY_PORT= METRO_PORT= WATCHER_PORT= COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"' _ "${CONFIG}" >/dev/null 2>&1; then
  echo "ERROR: agentic.conf accepted missing slot/worktree ports." >&2
  exit 1
fi

GATEWAY_PORT=41235 METRO_PORT=41234 COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"; [[ "$GATEWAY_PORT" == 41235 && "$METRO_PORT" == 41234 ]]' _ "${CONFIG}"

env -u METRO_PORT GATEWAY_PORT=41235 WATCHER_PORT=42345 COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"; [[ "$METRO_PORT" == 42345 && "$WATCHER_PORT" == 42345 ]]' _ "${CONFIG}"

printf 'ok - Companion launch ports are required from slot/worktree configuration\n'
