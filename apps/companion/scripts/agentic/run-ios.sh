#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./slot-context.sh
source "${SCRIPT_DIR}/slot-context.sh"
# shellcheck source=./network.sh
source "${SCRIPT_DIR}/network.sh"

EXPO_ARGS=()
IOS_FORCE_DEVICE_PICK="${IOS_DEVICE_PICK:-0}"

companion_ios_sanitized_path() {
  local IFS=":"
  local parts=()
  local entry
  for entry in ${PATH}; do
    case "${entry}" in
      */Android/sdk/ndk/*/toolchains/llvm/prebuilt/*/bin)
        ;;
      *)
        parts+=("${entry}")
        ;;
    esac
  done
  local joined=""
  for entry in "${parts[@]}"; do
    if [[ -z "${joined}" ]]; then
      joined="${entry}"
    else
      joined="${joined}:${entry}"
    fi
  done
  printf '%s\n' "${joined}"
}

parse_ios_cli_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --ios-simulator|--simulator)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          echo "ERROR: $1 requires a simulator name or UDID." >&2
          return 1
        fi
        IOS_SIMULATOR="$2"
        DEVICE_MODE=simulator
        shift 2
        ;;
      --ios-simulator=*|--simulator=*)
        IOS_SIMULATOR="${1#*=}"
        DEVICE_MODE=simulator
        shift
        ;;
      --ios-device|--ios-device-udid)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          echo "ERROR: $1 requires a physical iOS device name or UDID." >&2
          return 1
        fi
        IOS_DEVICE_UDID="$2"
        DEVICE_MODE=device
        shift 2
        ;;
      --ios-device=*|--ios-device-udid=*)
        IOS_DEVICE_UDID="${1#*=}"
        DEVICE_MODE=device
        shift
        ;;
      --pick-device)
        IOS_FORCE_DEVICE_PICK=1
        DEVICE_MODE=device
        shift
        ;;
      --)
        shift
        EXPO_ARGS+=("$@")
        break
        ;;
      *)
        EXPO_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

has_explicit_expo_device_arg() {
  local arg
  for arg in "${EXPO_ARGS[@]}"; do
    if [[ "${arg}" == "--device" || "${arg}" == "-d" || "${arg}" == --device=* ]]; then
      return 0
    fi
  done
  return 1
}

# Expo CLI resolves `--device` against `xcrun devicectl` first, and devicectl lists booted
# simulators as connected devices, so a simulator target gets the physical-device path and
# fails on code signing. Simulator targets therefore build, install and open here instead.
companion_resolve_simulator_udid() {
  local target="$1"
  xcrun simctl list devices available -j | node -e '
    const target = process.argv[1];
    const devices = Object.values(JSON.parse(require("fs").readFileSync(0, "utf8")).devices).flat();
    const matches = devices.filter((d) => d.udid === target || d.name === target);
    if (matches.length !== 1) {
      console.error(`ERROR: expected one available simulator named or identified by "${target}", found ${matches.length}.`);
      process.exit(1);
    }
    process.stdout.write(matches[0].udid);
  ' "${target}"
}

companion_run_ios_simulator() {
  local udid workspace scheme derived app_path metro_url
  udid="$(companion_resolve_simulator_udid "$1")"
  workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print)"
  if [[ -z "${workspace}" || "$(printf '%s\n' "${workspace}" | wc -l | tr -d ' ')" != "1" ]]; then
    echo "ERROR: expected exactly one ios/*.xcworkspace; run expo prebuild first." >&2
    exit 1
  fi
  scheme="$(basename "${workspace}" .xcworkspace)"
  derived="ios/build/simulator-${udid}"
  metro_url="http://${COMPANION_PACKAGER_HOSTNAME}:${METRO_PORT}"
  if ! curl -fsS "http://127.0.0.1:${METRO_PORT}/status" >/dev/null 2>&1 &&
    ! curl -fsS "http://[::1]:${METRO_PORT}/status" >/dev/null 2>&1; then
    echo "ERROR: Metro is not answering on :${METRO_PORT}. Start it first (prepare-profile.sh warm), then rerun." >&2
    exit 1
  fi
  # Boots a shut-down simulator and waits until it can accept an install.
  xcrun simctl bootstatus "${udid}" -b
  echo "[run-ios] Building ${scheme} for simulator ${udid}"
  env "${RUN_ENV[@]}" RCT_NO_LAUNCH_PACKAGER=true xcodebuild \
    -workspace "${workspace}" -scheme "${scheme}" -configuration Debug \
    -destination "id=${udid}" -derivedDataPath "${derived}" \
    COMPILER_INDEX_STORE_ENABLE=NO build
  app_path="${derived}/Build/Products/Debug-iphonesimulator/${scheme}.app"
  xcrun simctl install "${udid}" "${app_path}"
  xcrun simctl openurl "${udid}" \
    "${SCHEME}://expo-development-client/?url=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "${metro_url}")"
  echo "[run-ios] Installed ${BUNDLE_ID} on ${udid}; dev client opened on ${metro_url}"
}

parse_ios_cli_args "$@"
companion_apply_farmslot_slot_context ios
IOS_TARGET="${IOS_DEVICE_UDID:-${IOS_SIMULATOR:-${SIMULATOR:-}}}"
if [[ -n "${IOS_DEVICE_UDID:-}" ]]; then
  DEVICE_MODE="${DEVICE_MODE:-device}"
elif [[ -n "${IOS_SIMULATOR:-${SIMULATOR:-}}" ]]; then
  DEVICE_MODE="${DEVICE_MODE:-simulator}"
elif [[ "${IOS_FORCE_DEVICE_PICK}" == "1" ]]; then
  DEVICE_MODE="${DEVICE_MODE:-device}"
else
  DEVICE_MODE="${DEVICE_MODE:-select}"
fi

if [[ ! -t 0 && -z "${IOS_TARGET}" && "${DEVICE_MODE}" == "select" ]]; then
  echo "ERROR: non-interactive iOS launch needs IOS_SIMULATOR, IOS_DEVICE_UDID, or DEVICE_MODE=device with IOS_DEVICE_PICK=1." >&2
  exit 1
fi

companion_load_local_auth_env
companion_configure_network_env

cd "${APP_DIR}"
export PATH="$(companion_ios_sanitized_path)"

RUN_ENV=(
  APP_VARIANT="${APP_VARIANT}"
  SITEED_BUNDLE_BASE="${SITEED_BUNDLE_BASE}"
  SITEED_SCHEME_BASE="${SITEED_SCHEME_BASE}"
  BUNDLE_ID="${BUNDLE_ID}"
  SCHEME="${SCHEME}"
  NODE_ENV=development
  METRO_PORT="${METRO_PORT}"
  RCT_METRO_PORT="${METRO_PORT}"
  EXPO_PUBLIC_GATEWAY_URL="${COMPANION_GATEWAY_URL}"
  EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1
  FARMSLOT_REMOTE_GATEWAY_URL="${FARMSLOT_REMOTE_GATEWAY_URL:-}"
  FARMSLOT_GATEWAY_TOKEN="${FARMSLOT_GATEWAY_TOKEN:-}"
  FARMSLOT_REMOTE_GATEWAY_TOKEN="${FARMSLOT_REMOTE_GATEWAY_TOKEN:-}"
  REACT_NATIVE_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME}"
  EXPO_PACKAGER_PROXY_URL="http://${COMPANION_PACKAGER_HOSTNAME}:${METRO_PORT}"
)

set +e
bash scripts/doctor/ios-build.sh
doctor_status=$?
set -e
if [[ "${doctor_status}" -eq 10 ]]; then
  case "${IOS_PREFLIGHT_REPAIR:-1}" in
    0|false|False|FALSE|no|No|NO|off|Off|OFF)
      exit "${doctor_status}"
      ;;
  esac
  echo "[run-ios] repairing generated iOS project for current Expo/RN packages" >&2
  env "${RUN_ENV[@]}" yarn expo prebuild --platform ios --clean
  echo "[run-ios] rechecking generated iOS project after repair" >&2
  bash scripts/doctor/ios-build.sh
elif [[ "${doctor_status}" -ne 0 ]]; then
  exit "${doctor_status}"
fi

if [[ "${DEVICE_MODE}" == "simulator" && -n "${IOS_TARGET}" ]]; then
  if [[ "${#EXPO_ARGS[@]}" -gt 0 ]]; then
    echo "ERROR: extra Expo arguments (${EXPO_ARGS[*]}) are not supported for simulator targets; expo run:ios --device would take the physical-device path." >&2
    exit 1
  fi
  echo "[run-ios] App variant: ${APP_VARIANT} (${BUNDLE_ID}, ${SCHEME}://)"
  echo "[run-ios] Metro port: ${METRO_PORT}"
  companion_run_ios_simulator "${IOS_TARGET}"
  exit 0
fi

args=(expo run:ios --port "${METRO_PORT}")
if ! has_explicit_expo_device_arg; then
  if [[ -n "${IOS_TARGET}" ]]; then
    args+=(--device "${IOS_TARGET}")
  elif [[ "${IOS_FORCE_DEVICE_PICK}" == "1" || "${DEVICE_MODE}" == "select" || "${DEVICE_MODE}" == "device" ]]; then
    args+=(--device)
  fi
fi
args+=("${EXPO_ARGS[@]}")

echo "[run-ios] App variant: ${APP_VARIANT} (${BUNDLE_ID}, ${SCHEME}://)"
echo "[run-ios] iOS target: ${IOS_TARGET:-Expo picker}"
echo "[run-ios] Metro port: ${METRO_PORT}"
echo "[run-ios] Metro connection: ${METRO_CONNECTION} (${COMPANION_PACKAGER_HOSTNAME})"
echo "[run-ios] Gateway URL: ${COMPANION_GATEWAY_URL}"

env "${RUN_ENV[@]}" yarn "${args[@]}"
