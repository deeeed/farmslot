#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"

if [[ -n "${PLATFORM:-}" ]]; then
  case "${PLATFORM}" in
    ios)
      exec bash "${SCRIPT_DIR}/run-ios.sh" "$@"
      ;;
    android)
      exec bash "${SCRIPT_DIR}/run-android.sh" "$@"
      ;;
    metro|start)
      exec bash "${SCRIPT_DIR}/start.sh" "$@"
      ;;
    *)
      echo "ERROR: unsupported PLATFORM '${PLATFORM}' (expected ios, android, metro, or start)." >&2
      exit 1
      ;;
  esac
fi

if [[ ! -t 0 ]]; then
  echo "ERROR: non-interactive launch requires PLATFORM=ios|android|metro." >&2
  exit 1
fi

cat >&2 <<MENU
Select Farmslot companion target:
  1) iOS simulator/device
  2) Android device
  3) Metro only
MENU
printf 'Target [1-3]: ' >&2
read -r selected
case "${selected}" in
  1)
    exec bash "${SCRIPT_DIR}/run-ios.sh" "$@"
    ;;
  2)
    exec bash "${SCRIPT_DIR}/run-android.sh" "$@"
    ;;
  3)
    exec bash "${SCRIPT_DIR}/start.sh" "$@"
    ;;
  *)
    echo "ERROR: invalid target selection '${selected}'." >&2
    exit 1
    ;;
esac
