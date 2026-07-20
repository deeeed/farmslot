#!/usr/bin/env bash
# Gateway sandbox + companion warm prepare for cross-surface first-party work.
#
#   bash projects/farmslot-farm/setup/sandbox-companion.sh --gateway-port 8809
set -euo pipefail

GATEWAY_PORT=""
METRO_PORT=""
SIMULATOR=""
ADB_SERIAL=""

usage() {
  echo "usage: $0 --gateway-port <port> [--metro-port <port>] [--simulator <name>] [--adb-serial <serial>]" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "ERROR: ${option} requires a value." >&2
    exit 1
  fi
  printf '%s' "${value}"
}

optional_flag_value() {
  local value="${1:-}"
  [[ -n "${value}" && "${value}" != --* ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-port)
      GATEWAY_PORT="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --metro-port)
      METRO_PORT="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --simulator)
      if optional_flag_value "${2:-}"; then
        SIMULATOR="${2}"
        shift 2
      else
        shift
      fi
      ;;
    --adb-serial)
      if optional_flag_value "${2:-}"; then
        ADB_SERIAL="${2}"
        shift 2
      else
        shift
      fi
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || usage

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${FARMSLOT_SLOT_REPO:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
METRO_PORT="${METRO_PORT:-$((GATEWAY_PORT + 70))}"

echo "[sandbox-companion] gateway :${GATEWAY_PORT} metro :${METRO_PORT}"
bash "${SCRIPT_DIR}/sandbox-dev.sh" start --gateway-port "${GATEWAY_PORT}"

cd "${REPO_ROOT}/apps/companion"
METRO_PORT="${METRO_PORT}" \
  GATEWAY_PORT="${GATEWAY_PORT}" \
  IOS_SIMULATOR="${SIMULATOR}" \
  ADB_SERIAL="${ADB_SERIAL}" \
  bash scripts/agentic/prepare-profile.sh warm

echo "[sandbox-companion] ready — gateway http://127.0.0.1:${GATEWAY_PORT} metro :${METRO_PORT}"
