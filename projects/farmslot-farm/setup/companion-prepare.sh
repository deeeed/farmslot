#!/usr/bin/env bash
# Companion prepare helper — derives Metro vs gateway ports from slot context.
#
#   bash projects/farmslot-farm/setup/companion-prepare.sh warm --slot-port 8809 --platform cli
#   bash projects/farmslot-farm/setup/companion-prepare.sh health --slot-port 8871 --platform ios
set -euo pipefail

MODE=""
SLOT_PORT=""
PLATFORM=""
SIMULATOR=""
ADB_SERIAL=""
METRO_OFFSET="${COMPANION_METRO_OFFSET:-70}"
GATEWAY_PORT_OVERRIDE=""

usage() {
  echo "usage: $0 warm|full|health --slot-port <port> --platform <cli|ios|android> [--simulator <name>] [--adb-serial <serial>] [--gateway-port <port>]" >&2
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
    --slot-port)
      SLOT_PORT="$(require_value "$1" "${2:-}")"
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
    --gateway-port)
      GATEWAY_PORT_OVERRIDE="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$MODE" && "$SLOT_PORT" =~ ^[0-9]+$ && -n "$PLATFORM" ]] || usage

derive_ports() {
  if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "android" ]]; then
    METRO_PORT="$SLOT_PORT"
    GATEWAY_PORT="${GATEWAY_PORT_OVERRIDE:-${COMPANION_GATEWAY_PORT:-7777}}"
  else
    GATEWAY_PORT="${GATEWAY_PORT_OVERRIDE:-$SLOT_PORT}"
    METRO_PORT=$((SLOT_PORT + METRO_OFFSET))
  fi
  export METRO_PORT GATEWAY_PORT
}

metro_health() {
  lsof -nP -iTCP:"${METRO_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1
}

derive_ports

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
