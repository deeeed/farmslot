#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"
FARMSLOT_BIN="${FARMSLOT_BIN:-${REPO_ROOT}/node_modules/.bin/farmslot}"
PLATFORM_VALUE="${PLATFORM:-ios}"
RUN_ID="${UX_RUN_ID:-${1:-}}"

if [[ -z "${FARMSLOT_SLOT_ID:-}" || -z "${RUN_ID}" ]]; then
  echo "Usage: FARMSLOT_SLOT_ID=<slot> PLATFORM=ios|android yarn recipe:run:ux-ready-gate <run-id>" >&2
  exit 1
fi

slot_id="${FARMSLOT_SLOT_ID}"
eval "$("${FARMSLOT_BIN}" internal slot-vars "${slot_id}" --shell)"
FARMSLOT_SLOT_ID="${slot_id}"
PLATFORM="${PLATFORM_VALUE}"
export FARMSLOT_SLOT_ID PLATFORM METRO_PORT IOS_SIMULATOR SIMULATOR ADB_SERIAL

# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./slot-context.sh
source "${SCRIPT_DIR}/slot-context.sh"
companion_apply_farmslot_slot_context "${PLATFORM_VALUE}"
export FARMSLOT_RECIPE_APP_ID="${BUNDLE_ID}"

case "${PLATFORM_VALUE}" in
  ios)
    xcrun simctl launch --terminate-running-process "${IOS_SIMULATOR}" "${BUNDLE_ID}" >/dev/null
    ;;
  android)
    adb -s "${ADB_SERIAL}" shell am force-stop "${BUNDLE_ID}"
    adb -s "${ADB_SERIAL}" shell monkey -p "${BUNDLE_ID}" -c android.intent.category.LAUNCHER 1 >/dev/null
    ;;
esac

artifacts_dir=".agent/ux-ready-gate-${FARMSLOT_SLOT_ID}-${PLATFORM_VALUE}"
cd "${APP_DIR}"
exec yarn farmslot-expo-recipe run \
  scripts/agentic/recipe/recipes/ux-ready-gate-catalog.recipe.json \
  --param "platform=${PLATFORM_VALUE}" \
  --param "run_id=${RUN_ID}" \
  --artifacts-dir "${artifacts_dir}"
