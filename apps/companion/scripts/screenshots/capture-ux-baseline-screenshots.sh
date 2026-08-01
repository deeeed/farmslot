#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTPUT_DIR="${FARMSLOT_UX_SCREENSHOT_DIR:-${APP_DIR}/.agent/ux-baseline-screenshots}"
OPEN_DEV_CLIENT="${OPEN_DEV_CLIENT:-1}"
START_METRO="${START_METRO:-1}"
CAPTURE_IOS="${CAPTURE_IOS:-1}"
CAPTURE_ANDROID="${CAPTURE_ANDROID:-1}"
REQUIRE_REVIEW_FLOW_CONTEXT="${REQUIRE_REVIEW_FLOW_CONTEXT:-0}"
CATALOG_ONLY="${CATALOG_ONLY:-0}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--ios-only|--android-only|--no-metro|--review-flow|--catalog-only]

Captures current Companion UX baseline screenshots for design review.
Always writes an offline-openable HTML catalog (index.html) next to screenshots.
Output defaults to: ${OUTPUT_DIR}

Optional route context:
  UX_RUN_ID=<run id>           Capture run detail, evidence, and run diff routes.
  UX_SLOT_ID=<slot id>         Capture slot workspace, terminal, slot diff, and worker terminal.
  UX_FAMILY_ID=<family id>     Capture family workspace route.
  UX_DECISION_ID=<decision id> Capture decision workspace route.
  --review-flow                Require UX_RUN_ID, UX_SLOT_ID, UX_FAMILY_ID, and UX_DECISION_ID.
  --catalog-only               Write route manifest + HTML report without device screenshots
                               (does not require Metro/port config).

Environment overrides (device capture):
  METRO_PORT / GATEWAY_PORT from slot port configuration (agentic.conf)
  APP_VARIANT, SCHEME, DEV_CLIENT_SCHEME, IOS_BUNDLE_ID, ANDROID_PACKAGE, ANDROID_SERIAL
  START_METRO
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ios-only)
      CAPTURE_IOS=1
      CAPTURE_ANDROID=0
      shift
      ;;
    --android-only)
      CAPTURE_IOS=0
      CAPTURE_ANDROID=1
      shift
      ;;
    --no-metro)
      START_METRO=0
      shift
      ;;
    --review-flow)
      REQUIRE_REVIEW_FLOW_CONTEXT=1
      shift
      ;;
    --catalog-only)
      CATALOG_ONLY=1
      CAPTURE_IOS=0
      CAPTURE_ANDROID=0
      START_METRO=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${REQUIRE_REVIEW_FLOW_CONTEXT}" == "1" ]]; then
  missing=()
  [[ -n "${UX_RUN_ID:-}" ]] || missing+=("UX_RUN_ID")
  [[ -n "${UX_SLOT_ID:-}" ]] || missing+=("UX_SLOT_ID")
  [[ -n "${UX_FAMILY_ID:-}" ]] || missing+=("UX_FAMILY_ID")
  [[ -n "${UX_DECISION_ID:-}" ]] || missing+=("UX_DECISION_ID")
  if (( ${#missing[@]} > 0 )); then
    echo "ERROR: --review-flow requires ${missing[*]}." >&2
    exit 1
  fi
fi

if [[ "${CATALOG_ONLY}" == "1" ]]; then
  : "${APP_VARIANT:=development}"
else
  # shellcheck source=../agentic/agentic.conf
  source "${SCRIPT_DIR}/../agentic/agentic.conf"
fi

case "${APP_VARIANT}" in
  development)
    DEFAULT_APP_ID="net.siteed.farmslot.development"
    DEFAULT_SCHEME="farmslot-development"
    DEFAULT_DEV_CLIENT_SCHEME="exp+farmslot-development"
    ;;
  preview)
    DEFAULT_APP_ID="net.siteed.farmslot.preview"
    DEFAULT_SCHEME="farmslot-preview"
    DEFAULT_DEV_CLIENT_SCHEME="exp+farmslot-preview"
    ;;
  production)
    DEFAULT_APP_ID="net.siteed.farmslot"
    DEFAULT_SCHEME="farmslot"
    DEFAULT_DEV_CLIENT_SCHEME="exp+farmslot"
    ;;
  *) echo "ERROR: unsupported APP_VARIANT '${APP_VARIANT}' (expected development, preview, or production)." >&2; exit 1 ;;
esac

SCHEME="${SCHEME:-${DEFAULT_SCHEME}}"
DEV_CLIENT_SCHEME="${DEV_CLIENT_SCHEME:-${DEFAULT_DEV_CLIENT_SCHEME}}"
DEV_CLIENT_SCHEME_FALLBACK="${DEV_CLIENT_SCHEME_FALLBACK:-exp+farmslot}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-${DEFAULT_APP_ID}}"
ANDROID_PACKAGE="${ANDROID_PACKAGE:-${DEFAULT_APP_ID}}"
IOS_DEVICE="${IOS_DEVICE:-booted}"
ANDROID_SERIAL="${ANDROID_SERIAL:-${ADB_SERIAL:-}}"

ROUTES=(
  "01_review|runs"
  "02_terminals|workers"
  "03_advanced|advanced"
  "04_settings|settings"
  "05_raw_fleet|fleet"
  "06_raw_prs|prs"
  "07_raw_inbox|inbox"
)

if [[ -n "${UX_RUN_ID:-}" ]]; then
  ROUTES+=("10_run_detail|run/${UX_RUN_ID}")
  ROUTES+=("11_run_evidence|artifacts/${UX_RUN_ID}")
  ROUTES+=("12_run_diff|diff/${UX_RUN_ID}")
fi
if [[ -n "${UX_SLOT_ID:-}" ]]; then
  ROUTES+=("20_slot_workspace|slot/${UX_SLOT_ID}")
  ROUTES+=("21_slot_terminal|terminal/${UX_SLOT_ID}")
  ROUTES+=("22_slot_diff|diff/slot/${UX_SLOT_ID}")
  ROUTES+=("23_worker_terminal|terminal/worker")
fi
if [[ -n "${UX_FAMILY_ID:-}" ]]; then
  ROUTES+=("30_family_workspace|family/${UX_FAMILY_ID}")
fi
if [[ -n "${UX_DECISION_ID:-}" ]]; then
  ROUTES+=("40_decision|decision/${UX_DECISION_ID}")
fi

wait_for_port() {
  local port="$1"
  local tries=80
  while (( tries > 0 )); do
    if python3 - <<PY >/dev/null 2>&1
import urllib.request
urllib.request.urlopen('http://localhost:${port}', timeout=0.5).close()
PY
    then
      return 0
    fi
    sleep 0.5
    tries=$((tries - 1))
  done
  echo "ERROR: Metro did not start on port ${port}." >&2
  return 1
}

select_android_serial() {
  if [[ -n "${ANDROID_SERIAL}" ]]; then
    printf '%s\n' "${ANDROID_SERIAL}"
    return 0
  fi
  adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }'
}

start_metro() {
  if [[ "${START_METRO}" != "1" ]]; then
    return 0
  fi
  local log="/tmp/farmslot-ux-baseline-metro.log"
  echo "[ux-screenshots] starting Metro on ${METRO_PORT}; log: ${log}"
  (
    cd "${APP_DIR}"
    env \
      APP_VARIANT="${APP_VARIANT}" \
      NODE_ENV=development \
      METRO_PORT="${METRO_PORT}" \
      RCT_METRO_PORT="${METRO_PORT}" \
      EXPO_PUBLIC_STORE_SCREENSHOTS=1 \
      yarn expo start --dev-client --port "${METRO_PORT}" --localhost
  ) >"${log}" 2>&1 &
  METRO_PID=$!
  trap 'if [[ -n "${METRO_PID:-}" ]]; then kill "${METRO_PID}" >/dev/null 2>&1 || true; fi' EXIT
  wait_for_port "${METRO_PORT}"
  sleep 4
}

capture_ios() {
  local out_dir="${OUTPUT_DIR}/ios"
  mkdir -p "${out_dir}"
  echo "[ux-screenshots] launching iOS ${IOS_BUNDLE_ID} on ${IOS_DEVICE}"
  if [[ "${OPEN_DEV_CLIENT}" == "1" ]]; then
    if ! xcrun simctl openurl "${IOS_DEVICE}" "${DEV_CLIENT_SCHEME}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}" >/dev/null; then
      xcrun simctl openurl "${IOS_DEVICE}" "${DEV_CLIENT_SCHEME_FALLBACK}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}" >/dev/null
    fi
  else
    xcrun simctl launch "${IOS_DEVICE}" "${IOS_BUNDLE_ID}" >/dev/null
  fi
  sleep 6
  local spec key route
  for spec in "${ROUTES[@]}"; do
    key="${spec%%|*}"
    route="${spec##*|}"
    echo "[ux-screenshots] iOS ${key} (${route})"
    xcrun simctl openurl "${IOS_DEVICE}" "${SCHEME}://${route}" >/dev/null
    sleep 2.5
    xcrun simctl io "${IOS_DEVICE}" screenshot "${out_dir}/${key}.png" >/dev/null
  done
}

capture_android() {
  local serial
  serial="$(select_android_serial)"
  if [[ -z "${serial}" ]]; then
    echo "ERROR: no Android device found. Set ANDROID_SERIAL or connect a device." >&2
    return 1
  fi
  local out_dir="${OUTPUT_DIR}/android"
  mkdir -p "${out_dir}"
  ensure_android_awake() {
    # Physical devices can stay on the notification shade or dim to black between
    # route launches. Wake and collapse system chrome so screenshots prove the app.
    adb -s "${serial}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    adb -s "${serial}" shell wm dismiss-keyguard >/dev/null 2>&1 || true
    adb -s "${serial}" shell cmd statusbar collapse >/dev/null 2>&1 || true
  }
  assert_android_app_visible() {
    local focus
    focus="$(adb -s "${serial}" shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' || true)"
    if printf '%s\n' "${focus}" | grep -q 'NotificationShade'; then
      echo "ERROR: Android device is locked or showing NotificationShade; unlock it before capturing screenshots." >&2
      printf '%s\n' "${focus}" >&2
      return 1
    fi
  }
  echo "[ux-screenshots] launching Android ${ANDROID_PACKAGE} on ${serial}"
  ensure_android_awake
  adb -s "${serial}" reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null
  adb -s "${serial}" shell am force-stop "${ANDROID_PACKAGE}" >/dev/null 2>&1 || true
  if [[ "${OPEN_DEV_CLIENT}" == "1" ]]; then
    if ! adb -s "${serial}" shell am start -a android.intent.action.VIEW -d "${DEV_CLIENT_SCHEME}://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${METRO_PORT}" "${ANDROID_PACKAGE}" >/dev/null; then
      echo "[ux-screenshots] dev-client scheme ${DEV_CLIENT_SCHEME} unavailable; trying ${DEV_CLIENT_SCHEME_FALLBACK}" >&2
      adb -s "${serial}" shell am start -a android.intent.action.VIEW -d "${DEV_CLIENT_SCHEME_FALLBACK}://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${METRO_PORT}" "${ANDROID_PACKAGE}" >/dev/null
    fi
    if ! adb -s "${serial}" shell pidof "${ANDROID_PACKAGE}" >/dev/null; then
      echo "[ux-screenshots] dev-client launch failed; launching ${ANDROID_PACKAGE} directly" >&2
      adb -s "${serial}" shell monkey -p "${ANDROID_PACKAGE}" 1 >/dev/null
    fi
  else
    adb -s "${serial}" shell monkey -p "${ANDROID_PACKAGE}" 1 >/dev/null
  fi
  sleep 8
  local spec key route
  for spec in "${ROUTES[@]}"; do
    key="${spec%%|*}"
    route="${spec##*|}"
    echo "[ux-screenshots] Android ${key} (${route})"
    ensure_android_awake
    adb -s "${serial}" shell am start -a android.intent.action.VIEW -d "${SCHEME}://${route}" "${ANDROID_PACKAGE}" >/dev/null
    sleep 3
    ensure_android_awake
    assert_android_app_visible
    adb -s "${serial}" exec-out screencap -p >"${out_dir}/${key}.png"
  done
}

rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

if [[ "${CATALOG_ONLY}" != "1" ]]; then
  start_metro
  if [[ "${CAPTURE_IOS}" == "1" ]]; then
    capture_ios
  fi
  if [[ "${CAPTURE_ANDROID}" == "1" ]]; then
    capture_android
  fi
else
  mkdir -p "${OUTPUT_DIR}/catalog"
  echo "[ux-screenshots] catalog-only mode — skipping device capture"
fi

{
  printf '{\n'
  printf '  "capturedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "variant": "%s",\n' "${APP_VARIANT}"
  printf '  "catalogOnly": %s,\n' "$([[ "${CATALOG_ONLY}" == "1" ]] && echo true || echo false)"
  printf '  "context": {\n'
  printf '    "runId": %s,\n' "$(if [[ -n "${UX_RUN_ID:-}" ]]; then printf '"%s"' "${UX_RUN_ID}"; else printf 'null'; fi)"
  printf '    "slotId": %s,\n' "$(if [[ -n "${UX_SLOT_ID:-}" ]]; then printf '"%s"' "${UX_SLOT_ID}"; else printf 'null'; fi)"
  printf '    "familyId": %s,\n' "$(if [[ -n "${UX_FAMILY_ID:-}" ]]; then printf '"%s"' "${UX_FAMILY_ID}"; else printf 'null'; fi)"
  printf '    "decisionId": %s\n' "$(if [[ -n "${UX_DECISION_ID:-}" ]]; then printf '"%s"' "${UX_DECISION_ID}"; else printf 'null'; fi)"
  printf '  },\n'
  printf '  "routes": [\n'
  index=0
  for route in "${ROUTES[@]}"; do
    if (( index > 0 )); then
      printf ',\n'
    fi
    printf '    "%s"' "${route}"
    index=$((index + 1))
  done
  printf '\n  ]\n'
  printf '}\n'
} >"${OUTPUT_DIR}/manifest.json"

node "${SCRIPT_DIR}/generate-ux-catalog-html.mjs" --output-dir "${OUTPUT_DIR}"

echo "[ux-screenshots] wrote ${OUTPUT_DIR}"
echo "[ux-screenshots] open ${OUTPUT_DIR}/index.html for the offline catalog report"
