#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RAW_DIR="${APP_DIR}/store-assets/raw"
# shellcheck source=../agentic/agentic.conf
source "${SCRIPT_DIR}/../agentic/agentic.conf"
APP_VARIANT="${APP_VARIANT:-development}"
OPEN_DEV_CLIENT="${OPEN_DEV_CLIENT:-1}"
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
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-${DEFAULT_APP_ID}}"
ANDROID_PACKAGE="${ANDROID_PACKAGE:-${DEFAULT_APP_ID}}"
IOS_DEVICE="${IOS_DEVICE:-booted}"
ANDROID_SERIAL="${ANDROID_SERIAL:-${ADB_SERIAL:-}}"
START_METRO="${START_METRO:-1}"
CAPTURE_IOS="${CAPTURE_IOS:-1}"
CAPTURE_ANDROID="${CAPTURE_ANDROID:-1}"

ROUTES=(
  "01_fleet|fleet"
  "02_recipes|runs"
  "03_workers|workers"
  "04_pull_requests|prs"
  "05_gateway|settings"
)

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--ios-only|--android-only|--no-metro]

Environment overrides:
  METRO_PORT=${METRO_PORT}
  APP_VARIANT=${APP_VARIANT}
  SCHEME=${SCHEME}
  DEV_CLIENT_SCHEME=${DEV_CLIENT_SCHEME}
  OPEN_DEV_CLIENT=${OPEN_DEV_CLIENT}
  IOS_BUNDLE_ID=${IOS_BUNDLE_ID}
  IOS_DEVICE=${IOS_DEVICE}
  ANDROID_PACKAGE=${ANDROID_PACKAGE}
  ANDROID_SERIAL=${ANDROID_SERIAL:-auto}
  START_METRO=${START_METRO}

The app must already be installed as a development build. The script runs Metro
with EXPO_PUBLIC_STORE_SCREENSHOTS=1, opens real app routes, captures raw device
screenshots, then regenerates framed store assets.
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
  local log="/tmp/farmslot-store-screenshots-metro.log"
  echo "[screenshots] starting Metro on ${METRO_PORT}; log: ${log}"
  (
    cd "${APP_DIR}"
    env \
      APP_VARIANT="${APP_VARIANT}" \
      NODE_ENV=development \
      METRO_PORT="${METRO_PORT}" \
      RCT_METRO_PORT="${METRO_PORT}" \
      EXPO_PUBLIC_STORE_SCREENSHOTS=1 \
      EXPO_PUBLIC_GATEWAY_URL= \
      yarn expo start --dev-client --port "${METRO_PORT}" --localhost
  ) >"${log}" 2>&1 &
  METRO_PID=$!
  trap 'if [[ -n "${METRO_PID:-}" ]]; then kill "${METRO_PID}" >/dev/null 2>&1 || true; fi' EXIT
  wait_for_port "${METRO_PORT}"
  sleep 4
}

capture_ios_phone() {
  local out_dir="${RAW_DIR}/ios-phone"
  mkdir -p "${out_dir}"
  echo "[screenshots] launching iOS ${IOS_BUNDLE_ID} on ${IOS_DEVICE}"
  if [[ "${OPEN_DEV_CLIENT}" == "1" ]]; then
    xcrun simctl openurl "${IOS_DEVICE}" "${DEV_CLIENT_SCHEME}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}" >/dev/null
  else
    xcrun simctl launch "${IOS_DEVICE}" "${IOS_BUNDLE_ID}" >/dev/null
  fi
  sleep 6
  local spec key route
  for spec in "${ROUTES[@]}"; do
    key="${spec%%|*}"
    route="${spec##*|}"
    echo "[screenshots] iOS ${key} (${route})"
    xcrun simctl openurl "${IOS_DEVICE}" "${SCHEME}://${route}" >/dev/null
    sleep 2.5
    xcrun simctl io "${IOS_DEVICE}" screenshot "${out_dir}/${key}.png" >/dev/null
  done
}

capture_android_phone() {
  local serial
  serial="$(select_android_serial)"
  if [[ -z "${serial}" ]]; then
    echo "ERROR: no Android device found. Set ANDROID_SERIAL or connect a device." >&2
    return 1
  fi
  local out_dir="${RAW_DIR}/android-phone"
  mkdir -p "${out_dir}"
  echo "[screenshots] launching Android ${ANDROID_PACKAGE} on ${serial}"
  adb -s "${serial}" reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null
  adb -s "${serial}" shell am force-stop "${ANDROID_PACKAGE}" >/dev/null 2>&1 || true
  if [[ "${OPEN_DEV_CLIENT}" == "1" ]]; then
    adb -s "${serial}" shell am start -a android.intent.action.VIEW -d "${DEV_CLIENT_SCHEME}://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${METRO_PORT}" "${ANDROID_PACKAGE}" >/dev/null
  else
    adb -s "${serial}" shell monkey -p "${ANDROID_PACKAGE}" 1 >/dev/null
  fi
  sleep 8
  local spec key route
  for spec in "${ROUTES[@]}"; do
    key="${spec%%|*}"
    route="${spec##*|}"
    echo "[screenshots] Android ${key} (${route})"
    adb -s "${serial}" shell am start -a android.intent.action.VIEW -d "${SCHEME}://${route}" "${ANDROID_PACKAGE}" >/dev/null
    sleep 3
    adb -s "${serial}" exec-out screencap -p >"${out_dir}/${key}.png"
  done
}

start_metro
if [[ "${CAPTURE_IOS}" == "1" ]]; then
  capture_ios_phone
fi
if [[ "${CAPTURE_ANDROID}" == "1" ]]; then
  capture_android_phone
fi

python3 "${SCRIPT_DIR}/generate-store-screenshots.py"
