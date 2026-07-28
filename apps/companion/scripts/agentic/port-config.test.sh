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

if env -u METRO_PORT FARMSLOT_LOCAL_RUNTIME_CONFIG=1 APP_VARIANT=development node -e "require(process.argv[1])" \
  "${APP_DIR}/metro.config.js" >/dev/null 2>&1; then
  echo "ERROR: Metro config accepted a development launch without METRO_PORT." >&2
  exit 1
fi

env -u METRO_PORT -u FARMSLOT_LOCAL_RUNTIME_CONFIG APP_VARIANT=development node -e \
  "require(process.argv[1])" "${APP_DIR}/metro.config.js"

env -u METRO_PORT FARMSLOT_LOCAL_RUNTIME_CONFIG=1 APP_VARIANT=preview node -e \
  "require(process.argv[1])" "${APP_DIR}/metro.config.js"

METRO_PORT=41234 FARMSLOT_LOCAL_RUNTIME_CONFIG=1 APP_VARIANT=development node -e \
  "const config = require(process.argv[1]); if (config.server.port !== 41234) process.exit(1)" \
  "${APP_DIR}/metro.config.js"

if METRO_PORT=65536 FARMSLOT_LOCAL_RUNTIME_CONFIG=1 APP_VARIANT=development node -e \
  "require(process.argv[1])" "${APP_DIR}/metro.config.js" >/dev/null 2>&1; then
  echo "ERROR: Metro config accepted a port above 65535." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
printf 'GATEWAY_PORT=45101\nMETRO_PORT=45102\n' > "${TMP_DIR}/ports"
cat > "${TMP_DIR}/recipe-bin" <<'EOF'
#!/usr/bin/env bash
printf '%s %s %s\n' "${GATEWAY_PORT}" "${METRO_PORT}" "${FARMSLOT_LOCAL_RUNTIME_CONFIG}"
EOF
chmod +x "${TMP_DIR}/recipe-bin"
recipe_output="$(
  env -u GATEWAY_PORT -u METRO_PORT \
    COMPANION_AGENTIC_PORT_ENV="${TMP_DIR}/ports" \
    COMPANION_AGENTIC_LOCAL_CONF=/dev/null \
    COMPANION_EXPO_RECIPE_BIN="${TMP_DIR}/recipe-bin" \
    bash "${SCRIPT_DIR}/run-recipe.sh"
)"
[[ "${recipe_output}" == "45101 45102 1" ]] || {
  echo "ERROR: recipe entry point did not load checkout-local .env.ports." >&2
  exit 1
}

printf 'ok - Companion launch ports are required from slot/worktree configuration\n'
