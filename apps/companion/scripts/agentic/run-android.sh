#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./network.sh
source "${SCRIPT_DIR}/network.sh"

EXPO_ARGS=()

parse_android_cli_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --android-device|--adb-serial|--target-device|--target)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          echo "ERROR: $1 requires a device serial, wireless ADB host, or wireless ADB host:port." >&2
          return 1
        fi
        ANDROID_DEVICE="$2"
        ANDROID_DEVICE_PICK=0
        shift 2
        ;;
      --android-device=*|--adb-serial=*|--target-device=*|--target=*)
        ANDROID_DEVICE="${1#*=}"
        ANDROID_DEVICE_PICK=0
        shift
        ;;
      --device)
        if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
          echo "ERROR: --device requires a device serial, wireless ADB host, or wireless ADB host:port." >&2
          return 1
        fi
        ANDROID_DEVICE="$2"
        ANDROID_DEVICE_PICK=0
        shift 2
        ;;
      --device=*)
        ANDROID_DEVICE="${1#*=}"
        ANDROID_DEVICE_PICK=0
        shift
        ;;
      --pick-device)
        ANDROID_DEVICE_PICK=1
        shift
        ;;
      --)
        shift
        EXPO_ARGS+=("$@")
        break
        ;;
      -*)
        EXPO_ARGS+=("$1")
        shift
        ;;
      *)
        if [[ "${#EXPO_ARGS[@]}" -eq 0 ]]; then
          ANDROID_DEVICE="$1"
          ANDROID_DEVICE_PICK=0
        else
          EXPO_ARGS+=("$1")
        fi
        shift
        ;;
    esac
  done
}

android_model_token_from_adb_line() {
  local line="$1"
  awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^model:/) {
        sub(/^model:/, "", $i)
        print $i
        exit
      }
    }
  }' <<<"${line}"
}

android_human_name() {
  local serial="$1"
  local line="${2:-}"
  local name=""

  if command -v adb >/dev/null 2>&1; then
    name="$(adb -s "${serial}" shell settings get global device_name </dev/null 2>/dev/null | tr -d '\r' | sed '/^$/d;/^null$/d' | head -1 || true)"
  fi
  if [[ -z "${name}" && -n "${line}" ]]; then
    name="$(android_model_token_from_adb_line "${line}" | tr '_' ' ')"
  fi
  if [[ -z "${name}" ]] && command -v adb >/dev/null 2>&1; then
    name="$(adb -s "${serial}" shell getprop ro.product.model </dev/null 2>/dev/null | tr -d '\r' | sed '/^$/d;/^null$/d' | head -1 || true)"
  fi

  printf '%s\n' "${name}"
}

android_label() {
  local serial="$1"
  local line="${2:-}"
  local name
  name="$(android_human_name "${serial}" "${line}")"
  if [[ -n "${name}" ]]; then
    printf '%s (%s)\n' "${name}" "${serial}"
  else
    printf '%s\n' "${serial}"
  fi
}

android_device_lines() {
  adb devices -l | awk 'NR > 1 && $2 == "device" { print }'
}

read_expo_android_package() {
  env "$@" yarn expo config --type public --json 2>/dev/null | node -e "
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      process.stdout.write(config.android?.package || '');
    });
  "
}

assert_android_identity_matches_expo_config() {
  local configured_package
  configured_package="$(read_expo_android_package "$@")"
  if [[ -z "${configured_package}" ]]; then
    echo "ERROR: Expo config did not produce android.package." >&2
    return 1
  fi
  if [[ "${configured_package}" != "${BUNDLE_ID}" ]]; then
    echo "ERROR: Android package mismatch before native build." >&2
    echo "  script BUNDLE_ID=${BUNDLE_ID}" >&2
    echo "  expo android.package=${configured_package}" >&2
    echo "Fix scripts/agentic/agentic.conf or app.config.ts so install and launch use the same package id." >&2
    return 1
  fi
}

native_android_build_gradle() {
  printf '%s\n' "${APP_DIR}/android/app/build.gradle"
}

native_android_package() {
  local build_gradle
  build_gradle="$(native_android_build_gradle)"
  if [[ ! -f "${build_gradle}" ]]; then
    return 0
  fi
  sed -n "s/^[[:space:]]*applicationId ['\"]\([^'\"]*\)['\"].*/\1/p" "${build_gradle}" | head -1
}

repair_android_native_identity() {
  env "$@" yarn expo prebuild --platform android --clean
}

ensure_android_native_identity() {
  local build_gradle native_package
  build_gradle="$(native_android_build_gradle)"
  if [[ ! -f "${build_gradle}" ]]; then
    echo "[run-android] Generated android/ is missing; Expo will create it for ${APP_VARIANT} (${BUNDLE_ID})." >&2
    return 0
  fi

  native_package="$(native_android_package)"
  if [[ "${native_package}" == "${BUNDLE_ID}" ]]; then
    return 0
  fi

  echo "ERROR: Android native identity does not match the selected app variant." >&2
  echo "  APP_VARIANT=${APP_VARIANT}" >&2
  echo "  script BUNDLE_ID=${BUNDLE_ID}" >&2
  if [[ -z "${native_package}" ]]; then
    echo "  android/app/build.gradle applicationId=<missing android/>" >&2
  else
    echo "  android/app/build.gradle applicationId=${native_package}" >&2
  fi
  echo "" >&2
  echo "Refusing to build/install because this could mix production and development builds." >&2
  echo "Generated android/ must match the selected variant before Gradle runs." >&2

  if [[ "${ANDROID_REPAIR_NATIVE:-0}" == "1" ]]; then
    echo "[run-android] ANDROID_REPAIR_NATIVE=1 set; rebuilding generated android/ for ${APP_VARIANT}." >&2
    repair_android_native_identity "$@"
    return 0
  fi

  if [[ -t 0 ]]; then
    printf 'Rebuild generated android/ for APP_VARIANT=%s now? [y/N] ' "${APP_VARIANT}" >&2
    local answer
    read -r answer
    case "${answer}" in
      y|Y|yes|YES)
        repair_android_native_identity "$@"
        return 0
        ;;
    esac
  fi

  echo "Aborting before Gradle build." >&2
  echo "Run again and answer yes, or run explicitly:" >&2
  echo "  cd apps/companion && APP_VARIANT=${APP_VARIANT} ANDROID_REPAIR_NATIVE=1 yarn android:device" >&2
  return 1
}

android_mdns_connect_target_for_serial() {
  local serial="$1"
  adb mdns services 2>/dev/null | awk -v serial="${serial}" '
    $2 == "_adb-tls-connect._tcp" && $1 ~ ("^adb-" serial "-") {
      print $3
      exit
    }
  '
}

connect_android_mdns_target_for_serial() {
  local serial="$1"
  local target
  target="$(android_mdns_connect_target_for_serial "${serial}")"
  if [[ -z "${target}" ]]; then
    return 1
  fi

  adb connect "${target}" >/dev/null
  printf '%s\n' "${target}"
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
    local mdns_target
    if mdns_target="$(connect_android_mdns_target_for_serial "${configured}")"; then
      local mdns_line
      mdns_line="$(android_device_lines | awk -v serial="${mdns_target}" '$1 == serial { print; exit }')"
      if [[ -n "${mdns_line}" ]]; then
        printf '%s\n' "${mdns_target}"
        return 0
      fi
    fi
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
      echo "ERROR: ANDROID_DEVICE=${configured} matched multiple wireless ADB devices; use yarn android:device or set the full serial." >&2
      printf '  %s\n' "${matches[@]}" >&2
      return 1
    fi
  fi

  echo "ERROR: configured Android device '${configured}' is not connected." >&2
  echo "Connected devices:" >&2
  android_device_lines >&2 || true
  return 1
}

select_android_device() {
  local configured="${ANDROID_DEVICE:-${ADB_SERIAL:-${ANDROID_SERIAL:-}}}"
  if [[ "${ANDROID_DEVICE_PICK:-0}" != "1" && -n "${configured}" ]]; then
    resolve_configured_android_device "${configured}"
    return 0
  fi

  if ! command -v adb >/dev/null 2>&1; then
    echo "ERROR: ANDROID_DEVICE is not set and adb is not available to list devices." >&2
    echo "Set ANDROID_DEVICE in scripts/agentic/agentic.local.conf." >&2
    return 1
  fi

  local devices=()
  while IFS= read -r line; do
    devices+=("${line}")
  done < <(android_device_lines)

  if [[ "${#devices[@]}" -eq 0 ]]; then
    echo "ERROR: ANDROID_DEVICE is not set and adb found no connected Android devices." >&2
    return 1
  fi

  if [[ "${#devices[@]}" -eq 1 ]]; then
    awk '{ print $1 }' <<<"${devices[0]}"
    return 0
  fi

  echo "Select Android device:" >&2
  local i serial
  for i in "${!devices[@]}"; do
    serial="$(awk '{ print $1 }' <<<"${devices[$i]}")"
    printf '  %d) %s\n' "$((i + 1))" "$(android_label "${serial}" "${devices[$i]}")" >&2
  done
  printf 'Device [1-%d]: ' "${#devices[@]}" >&2
  read -r selected
  if ! [[ "${selected}" =~ ^[0-9]+$ ]] || ((selected < 1 || selected > ${#devices[@]})); then
    echo "ERROR: invalid Android device selection '${selected}'." >&2
    return 1
  fi
  awk '{ print $1 }' <<<"${devices[$((selected - 1))]}"
}

main() {
parse_android_cli_args "$@"
DEVICE_MODE="${DEVICE_MODE:-device}"
companion_load_local_auth_env
companion_configure_network_env

cd "${APP_DIR}"

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
  REACT_NATIVE_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME}"
  EXPO_PACKAGER_PROXY_URL="http://${COMPANION_PACKAGER_HOSTNAME}:${METRO_PORT}"
)

assert_android_identity_matches_expo_config "${RUN_ENV[@]}"
ensure_android_native_identity "${RUN_ENV[@]}"

ANDROID_TARGET="$(select_android_device)"
ANDROID_LINE=""
ANDROID_EXPO_TARGET=""
if command -v adb >/dev/null 2>&1; then
  ANDROID_LINE="$(adb devices -l | awk -v serial="${ANDROID_TARGET}" '$1 == serial && $2 == "device" { print; exit }')"
  ANDROID_EXPO_TARGET="$(android_model_token_from_adb_line "${ANDROID_LINE}")"
fi
RUN_ENV+=(ANDROID_SERIAL="${ANDROID_TARGET}" ADB_SERIAL="${ANDROID_TARGET}")

args=(expo run:android --port "${METRO_PORT}" --app-id "${BUNDLE_ID}")
if [[ -n "${ANDROID_EXPO_TARGET}" ]]; then
  args+=(--device "${ANDROID_EXPO_TARGET}")
fi
args+=("${EXPO_ARGS[@]}")

echo "[run-android] Local native build/install via Expo (generated android/ is gitignored)"
echo "[run-android] App variant: ${APP_VARIANT} (${BUNDLE_ID}, ${SCHEME}://)"
echo "[run-android] Android device: $(android_label "${ANDROID_TARGET}" "${ANDROID_LINE}")"
echo "[run-android] Metro port: ${METRO_PORT}"
echo "[run-android] Metro connection: ${METRO_CONNECTION:-localhost} (${COMPANION_PACKAGER_HOSTNAME})"
echo "[run-android] Gateway URL: ${COMPANION_GATEWAY_URL}"

env "${RUN_ENV[@]}" yarn "${args[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
