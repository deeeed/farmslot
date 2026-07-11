#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"

RECIPE_PATH="scripts/agentic/recipe/recipes/expo.config.recipe.json"
ARTIFACTS_DIR=""
RUNTIME_DIR=""
PLATFORM_VALUE="${PLATFORM:-}"
METRO_PORT_VALUE="${METRO_PORT:-${WATCHER_PORT:-7677}}"
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

if [[ "${RECIPE_PATH}" == /* ]]; then
  RECIPE_ABSOLUTE_PATH="${RECIPE_PATH}"
else
  RECIPE_ABSOLUTE_PATH="${APP_DIR}/${RECIPE_PATH}"
fi
if [[ "${DRY_RUN}" -eq 0 ]] && node -e '
  const recipe = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const nativeActions = new Set(["ui.press", "ui.set_input", "ui.scroll", "ui.wait_for", "ui.screenshot"]);
  const containsNativeAction = (value) => {
    if (Array.isArray(value)) return value.some(containsNativeAction);
    if (!value || typeof value !== "object") return false;
    if (nativeActions.has(value.action)) return true;
    return Object.values(value).some(containsNativeAction);
  };
  process.exit(containsNativeAction(recipe) ? 0 : 1);
' "${RECIPE_ABSOLUTE_PATH}"; then
  case "${PLATFORM_VALUE}" in
    ios*)
      [[ -n "${SIMULATOR_VALUE}" ]] || {
        echo "ERROR: native iOS recipe actions require --simulator from the assigned Farmslot slot." >&2
        exit 1
      }
      ;;
    android*)
      [[ -n "${ADB_SERIAL_VALUE}" ]] || {
        echo "ERROR: native Android recipe actions require --adb-serial from the assigned Farmslot slot." >&2
        exit 1
      }
      ;;
    *)
      echo "ERROR: native recipe actions require --platform ios or android from the assigned Farmslot slot." >&2
      exit 1
      ;;
  esac
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
