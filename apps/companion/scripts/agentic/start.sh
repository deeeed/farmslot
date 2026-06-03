#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./network.sh
source "${SCRIPT_DIR}/network.sh"

EXPO_ARGS=()

parse_start_cli_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --android-device|--adb-serial|--target-device|--target|--device)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          echo "ERROR: $1 requires a device serial, wireless ADB host, or wireless ADB host:port." >&2
          return 1
        fi
        ANDROID_DEVICE="$2"
        shift 2
        ;;
      --android-device=*|--adb-serial=*|--target-device=*|--target=*|--device=*)
        ANDROID_DEVICE="${1#*=}"
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

android_model_from_adb_line() {
  local line="$1"
  awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^model:/) {
        sub(/^model:/, "", $i)
        gsub(/_/, " ", $i)
        print $i
        exit
      }
    }
  }' <<<"${line}"
}

android_device_name() {
  local serial="$1"
  local line="${2:-}"
  local name=""

  if command -v adb >/dev/null 2>&1; then
    name="$(adb -s "${serial}" shell settings get global device_name </dev/null 2>/dev/null | tr -d '\r' | sed '/^$/d;/^null$/d' | head -1 || true)"
  fi
  if [[ -z "${name}" && -n "${line}" ]]; then
    name="$(android_model_from_adb_line "${line}")"
  fi
  if [[ -z "${name}" ]]; then
    if command -v adb >/dev/null 2>&1; then
      name="$(adb -s "${serial}" shell getprop ro.product.model </dev/null 2>/dev/null | tr -d '\r' | sed '/^$/d;/^null$/d' | head -1 || true)"
    fi
  fi

  printf '%s\n' "${name}"
}

android_device_label() {
  local serial="$1"
  local line="${2:-}"
  local name
  name="$(android_device_name "${serial}" "${line}")"
  if [[ -n "${name}" ]]; then
    printf '%s (%s)\n' "${name}" "${serial}"
  else
    printf '%s\n' "${serial}"
  fi
}

android_device_lines() {
  adb devices -l | awk 'NR > 1 && $2 == "device" { print }'
}

resolve_configured_android_device() {
  local configured="$1"
  if ! command -v adb >/dev/null 2>&1; then
    printf '%s\n' "${configured}"
    return 0
  fi

  local exact_line
  exact_line="$(android_device_lines | awk -v serial="${configured}" '$1 == serial { print; exit }')"
  if [[ -n "${exact_line}" ]]; then
    printf '%s\n' "${configured}"
    return 0
  fi

  if [[ "${configured}" != *:* ]]; then
    local matches=()
    while IFS= read -r line; do
      matches+=("${line}")
    done < <(android_device_lines | awk -v host="${configured}" '$1 ~ ("^" host ":") { print }')

    if [[ "${#matches[@]}" -eq 1 ]]; then
      awk '{ print $1 }' <<<"${matches[0]}"
      return 0
    fi

    if [[ "${#matches[@]}" -gt 1 ]]; then
      echo "ERROR: ANDROID_DEVICE=${configured} matched multiple wireless ADB devices; set the full serial." >&2
      printf '  %s\n' "${matches[@]}" >&2
      return 1
    fi
  fi

  echo "ERROR: configured Android device '${configured}' is not connected." >&2
  echo "Connected devices:" >&2
  android_device_lines >&2 || true
  return 1
}

parse_start_cli_args "$@"
DEVICE_MODE="${DEVICE_MODE:-auto}"

cd "${APP_DIR}"

should_open_android=0
for arg in "${EXPO_ARGS[@]}"; do
  if [[ "${arg}" == "--android" || "${arg}" == "-a" ]]; then
    should_open_android=1
    break
  fi
done

ANDROID_TARGET="${ANDROID_DEVICE:-${ADB_SERIAL:-}}"
if [[ -n "${ANDROID_TARGET}" ]]; then
  DEVICE_MODE="${DEVICE_MODE:-device}"
fi
companion_load_local_auth_env
companion_configure_network_env
if [[ -n "${ANDROID_TARGET}" ]]; then
  ANDROID_TARGET="$(resolve_configured_android_device "${ANDROID_TARGET}")"
elif [[ "${should_open_android}" -eq 1 ]]; then
  if ! command -v adb >/dev/null 2>&1; then
    echo "ERROR: ANDROID_DEVICE is not set and adb is not available to list devices." >&2
    echo "Set ANDROID_DEVICE in scripts/agentic/agentic.local.conf." >&2
    exit 1
  fi

  android_devices=()
  while IFS= read -r device_line; do
    android_devices+=("${device_line}")
  done < <(android_device_lines)

  if [[ "${#android_devices[@]}" -eq 0 ]]; then
    echo "ERROR: ANDROID_DEVICE is not set and adb found no connected Android devices." >&2
    echo "Connect a device or set ANDROID_DEVICE in scripts/agentic/agentic.local.conf." >&2
    exit 1
  elif [[ "${#android_devices[@]}" -eq 1 ]]; then
    ANDROID_TARGET="$(awk '{ print $1 }' <<<"${android_devices[0]}")"
    echo "[start] ANDROID_DEVICE unset; using only connected Android device: $(android_device_label "${ANDROID_TARGET}" "${android_devices[0]}")"
  else
    echo "Select Android device:"
    for i in "${!android_devices[@]}"; do
      serial="$(awk '{ print $1 }' <<<"${android_devices[$i]}")"
      printf '  %d) %s\n' "$((i + 1))" "$(android_device_label "${serial}" "${android_devices[$i]}")"
    done
    printf 'Device [1-%d]: ' "${#android_devices[@]}"
    read -r selected_device_index
    if ! [[ "${selected_device_index}" =~ ^[0-9]+$ ]] ||
      ((selected_device_index < 1 || selected_device_index > ${#android_devices[@]})); then
      echo "ERROR: invalid Android device selection '${selected_device_index}'." >&2
      exit 1
    fi
    ANDROID_TARGET="$(awk '{ print $1 }' <<<"${android_devices[$((selected_device_index - 1))]}")"
  fi
fi

ANDROID_LABEL=""
if [[ -n "${ANDROID_TARGET}" ]]; then
  ANDROID_LINE=""
  if command -v adb >/dev/null 2>&1; then
    ANDROID_LINE="$(adb devices -l | awk -v serial="${ANDROID_TARGET}" '$1 == serial && $2 == "device" { print; exit }')"
  fi
  ANDROID_LABEL="$(android_device_label "${ANDROID_TARGET}" "${ANDROID_LINE}")"
fi

RUN_ENV=(
  APP_VARIANT="${APP_VARIANT}"
  SITEED_BUNDLE_BASE="${SITEED_BUNDLE_BASE}"
  SITEED_SCHEME_BASE="${SITEED_SCHEME_BASE}"
  BUNDLE_ID="${BUNDLE_ID}"
  SCHEME="${SCHEME}"
  NODE_ENV=development
  METRO_PORT="${METRO_PORT}"
  EXPO_PUBLIC_GATEWAY_URL="${COMPANION_GATEWAY_URL}"
  FARMSLOT_REMOTE_GATEWAY_URL="${FARMSLOT_REMOTE_GATEWAY_URL:-}"
  FARMSLOT_GATEWAY_TOKEN="${FARMSLOT_GATEWAY_TOKEN:-}"
  FARMSLOT_REMOTE_GATEWAY_TOKEN="${FARMSLOT_REMOTE_GATEWAY_TOKEN:-}"
)

if [[ -n "${ANDROID_TARGET}" ]]; then
  RUN_ENV+=(ANDROID_SERIAL="${ANDROID_TARGET}" ADB_SERIAL="${ANDROID_TARGET}")
fi

args=(expo start --dev-client --port "${METRO_PORT}")
if [[ "${METRO_CONNECTION:-localhost}" == "lan" ]]; then
  RUN_ENV+=(REACT_NATIVE_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME}")
  args+=(--lan)
else
  RUN_ENV+=(REACT_NATIVE_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME}")
  args+=(--localhost)
fi
args+=("${EXPO_ARGS[@]}")

echo "[start] Metro port: ${METRO_PORT}"
echo "[start] App variant: ${APP_VARIANT} (${BUNDLE_ID}, ${SCHEME}://)"
echo "[start] Metro connection: ${METRO_CONNECTION:-localhost} (${COMPANION_PACKAGER_HOSTNAME})"
echo "[start] Gateway URL: ${COMPANION_GATEWAY_URL}"
if [[ "${should_open_android}" -eq 1 ]]; then
  echo "[start] Android device: ${ANDROID_LABEL:-Expo default}"
fi

env "${RUN_ENV[@]}" yarn "${args[@]}"
