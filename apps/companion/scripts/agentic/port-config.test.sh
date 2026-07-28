#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG="${SCRIPT_DIR}/agentic.conf"

if GATEWAY_PORT= METRO_PORT= WATCHER_PORT= COMPANION_AGENTIC_PORT_ENV=/dev/null COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"' _ "${CONFIG}" >/dev/null 2>&1; then
  echo "ERROR: agentic.conf accepted missing slot/worktree ports." >&2
  exit 1
fi

GATEWAY_PORT=41235 METRO_PORT=41234 COMPANION_AGENTIC_PORT_ENV=/dev/null COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"; [[ "$GATEWAY_PORT" == 41235 && "$METRO_PORT" == 41234 ]]' _ "${CONFIG}"

if env -u METRO_PORT GATEWAY_PORT=41235 WATCHER_PORT=42345 COMPANION_AGENTIC_PORT_ENV=/dev/null COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
  bash -c 'source "$1"' _ "${CONFIG}" >/dev/null 2>&1; then
  echo "ERROR: agentic.conf aliased METRO_PORT to WATCHER_PORT." >&2
  exit 1
fi

if env -u METRO_PORT APP_VARIANT=development node -e "require(process.argv[1])" \
  "${APP_DIR}/metro.config.js" >/dev/null 2>&1; then
  echo "ERROR: Metro config accepted a development launch without METRO_PORT." >&2
  exit 1
fi

METRO_PORT=41234 APP_VARIANT=development node -e \
  "const config = require(process.argv[1]); if (config.server.port !== 41234) process.exit(1)" \
  "${APP_DIR}/metro.config.js"

printf 'ok - Companion launch ports are required from slot/worktree configuration\n'
