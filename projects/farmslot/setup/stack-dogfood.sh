#!/usr/bin/env bash
# Gateway sandbox + companion warm prepare for cross-surface farmslot dogfood.
#
#   bash projects/farmslot/setup/stack-dogfood.sh --gateway-port 8809
set -euo pipefail

GATEWAY_PORT=""
METRO_PORT=""
SIMULATOR=""
ADB_SERIAL=""

usage() {
  echo "usage: $0 --gateway-port <port> [--metro-port <port>] [--simulator <name>] [--adb-serial <serial>]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-port)
      GATEWAY_PORT="${2:-}"
      shift 2
      ;;
    --metro-port)
      METRO_PORT="${2:-}"
      shift 2
      ;;
    --simulator)
      SIMULATOR="${2:-}"
      shift 2
      ;;
    --adb-serial)
      ADB_SERIAL="${2:-}"
      shift 2
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

echo "[stack-dogfood] gateway :${GATEWAY_PORT} metro :${METRO_PORT}"
bash "${SCRIPT_DIR}/sandbox-dev.sh" start --gateway-port "${GATEWAY_PORT}"

cd "${REPO_ROOT}/apps/companion"
METRO_PORT="${METRO_PORT}" \
  GATEWAY_PORT="${GATEWAY_PORT}" \
  IOS_SIMULATOR="${SIMULATOR}" \
  ADB_SERIAL="${ADB_SERIAL}" \
  bash scripts/agentic/prepare-profile.sh warm

echo "[stack-dogfood] ready — gateway http://127.0.0.1:${GATEWAY_PORT} metro :${METRO_PORT}"