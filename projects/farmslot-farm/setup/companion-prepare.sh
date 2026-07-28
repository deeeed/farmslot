#!/usr/bin/env bash
# Companion prepare helper — receives Metro and gateway ports from slot context.
#
#   bash projects/farmslot-farm/setup/companion-prepare.sh warm --gateway-port <port> --metro-port <port> --platform cli
set -euo pipefail

MODE=""
PLATFORM=""
SIMULATOR=""
ADB_SERIAL=""
GATEWAY_PORT=""
METRO_PORT=""

usage() {
  echo "usage: $0 warm|full|health --gateway-port <port> --metro-port <port> --platform <cli|ios|android> [--simulator <name>] [--adb-serial <serial>]" >&2
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
    warm|full|health)
      MODE="$1"
      shift
      ;;
    --gateway-port)
      GATEWAY_PORT="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --metro-port)
      METRO_PORT="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --platform)
      PLATFORM="$(require_value "$1" "${2:-}")"
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

[[ -n "$MODE" && "$GATEWAY_PORT" =~ ^[0-9]+$ && "$METRO_PORT" =~ ^[0-9]+$ && -n "$PLATFORM" ]] || usage
export METRO_PORT GATEWAY_PORT

metro_health() {
  lsof -nP -iTCP:"${METRO_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1
}

case "$MODE" in
  health)
    metro_health
    ;;
  warm|full)
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    REPO_ROOT="${FARMSLOT_SLOT_REPO:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
    cd "${REPO_ROOT}/apps/companion"
    METRO_PORT="${METRO_PORT}" \
      GATEWAY_PORT="${GATEWAY_PORT}" \
      IOS_SIMULATOR="${SIMULATOR}" \
      ADB_SERIAL="${ADB_SERIAL}" \
      bash scripts/agentic/prepare-profile.sh "${MODE}"
    ;;
esac
