#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./slot-context.sh
source "${SCRIPT_DIR}/slot-context.sh"

RECIPE_PATH="scripts/agentic/recipe/recipes/expo.config.recipe.json"
ARTIFACTS_DIR=""
RUNTIME_DIR=""
PLATFORM_VALUE="${PLATFORM:-}"
METRO_PORT_VALUE="${METRO_PORT}"
SIMULATOR_VALUE="${IOS_SIMULATOR:-${SIMULATOR:-}}"
ADB_SERIAL_VALUE="${ADB_SERIAL:-${ANDROID_SERIAL:-${ANDROID_DEVICE:-}}}"
RECORD_VIDEO=0
DRY_RUN=0

value_from_equals() {
  local option="$1"
  local value="${option#*=}"
  if [[ -z "${value}" ]]; then
    echo "ERROR: ${option%%=*} requires a value." >&2
    exit 1
  fi
  printf '%s' "${value}"
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

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --recipe)
      RECIPE_PATH="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --recipe=*)
      RECIPE_PATH="$(value_from_equals "$1")"; shift ;;
    --artifacts-dir)
      ARTIFACTS_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --artifacts-dir=*)
      ARTIFACTS_DIR="$(value_from_equals "$1")"; shift ;;
    --runtime-dir)
      RUNTIME_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --runtime-dir=*)
      RUNTIME_DIR="$(value_from_equals "$1")"; shift ;;
    --platform)
      PLATFORM_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --platform=*)
      PLATFORM_VALUE="$(value_from_equals "$1")"; shift ;;
    --metro-port)
      METRO_PORT_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --metro-port=*)
      METRO_PORT_VALUE="$(value_from_equals "$1")"; shift ;;
    --simulator)
      SIMULATOR_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --simulator=*)
      SIMULATOR_VALUE="$(value_from_equals "$1")"; shift ;;
    --adb-serial)
      ADB_SERIAL_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --adb-serial=*)
      ADB_SERIAL_VALUE="$(value_from_equals "$1")"; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --record-video=*)
      RECORD_VIDEO=1; shift ;;
    --record-video)
      RECORD_VIDEO=1; shift ;;
    *)
      echo "ERROR: unknown recipe validation option '$1'." >&2
      exit 1 ;;
  esac
done

if [[ -z "${ARTIFACTS_DIR}" ]]; then
  echo "ERROR: --artifacts-dir is required." >&2
  exit 1
fi

if [[ -n "${FARMSLOT_SLOT_ID:-}" ]]; then
  companion_apply_farmslot_slot_context "${PLATFORM_VALUE}"
  METRO_PORT_VALUE="${METRO_PORT}"
  SIMULATOR_VALUE="${IOS_SIMULATOR:-${SIMULATOR:-}}"
  ADB_SERIAL_VALUE="${ADB_SERIAL:-${ANDROID_SERIAL:-${ANDROID_DEVICE:-}}}"
fi

ARGS=(farmslot-expo-recipe run "${RECIPE_PATH}" --artifacts-dir "${ARTIFACTS_DIR}")
if [[ "${DRY_RUN}" -eq 1 ]]; then
  ARGS+=(--dry-run)
fi
if [[ "${RECORD_VIDEO}" -eq 1 ]]; then
  ARGS+=(--record-video=full-run)
fi

cd "${APP_DIR}"
# Forward slot context for custom project recipes and future live transports.
RUNTIME_DIR="${RUNTIME_DIR}" \
PLATFORM="${PLATFORM_VALUE}" \
METRO_PORT="${METRO_PORT_VALUE}" \
SIMULATOR="${SIMULATOR_VALUE}" \
ADB_SERIAL="${ADB_SERIAL_VALUE}" \
FARMSLOT_RECIPE_APP_ID="${BUNDLE_ID}" \
yarn "${ARGS[@]}"
