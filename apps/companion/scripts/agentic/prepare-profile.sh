#!/usr/bin/env bash
# Companion prepare profiles for farmslot project.json (companion-warm / companion-full).
#
#   bash scripts/agentic/prepare-profile.sh warm
#   bash scripts/agentic/prepare-profile.sh full
#
# Expects METRO_PORT, GATEWAY_PORT, IOS_SIMULATOR/SIMULATOR, ADB_SERIAL from slot hooks.
set -euo pipefail

MODE="${1:-}"
[[ "$MODE" == "warm" || "$MODE" == "full" ]] || {
  echo "usage: $0 warm|full" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./network.sh
source "${SCRIPT_DIR}/network.sh"

companion_load_local_auth_env
companion_configure_network_env

SIM_NAME="${IOS_SIMULATOR:-${SIMULATOR:-}}"
ADB_TARGET="${ADB_SERIAL:-${ANDROID_DEVICE:-}}"

boot_ios_sim_if_needed() {
  [[ -n "$SIM_NAME" ]] || return 0
  if xcrun simctl list devices booted 2>/dev/null | grep -q "${SIM_NAME}"; then
    echo "[prepare-profile] iOS sim already booted: ${SIM_NAME}"
    return 0
  fi
  echo "[prepare-profile] booting iOS sim: ${SIM_NAME}"
  xcrun simctl boot "${SIM_NAME}"
}

metro_listening() {
  lsof -nP -iTCP:"${METRO_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1
}

start_metro_background() {
  if metro_listening; then
    echo "[prepare-profile] Metro already listening on :${METRO_PORT}"
    return 0
  fi
  echo "[prepare-profile] starting Metro on :${METRO_PORT}"
  local log_file="${APP_DIR}/.agent/metro.log"
  mkdir -p "$(dirname "$log_file")"
  : >"${log_file}"
  (
    cd "${APP_DIR}"
    env \
      APP_VARIANT="${APP_VARIANT}" \
      METRO_PORT="${METRO_PORT}" \
      GATEWAY_PORT="${GATEWAY_PORT}" \
      EXPO_PUBLIC_GATEWAY_URL="${COMPANION_GATEWAY_URL}" \
      REACT_NATIVE_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME}" \
      yarn expo start --dev-client --port "${METRO_PORT}" --localhost
  ) >>"${log_file}" 2>&1 &
  local i=0
  while (( i < 45 )); do
    if metro_listening; then
      echo "[prepare-profile] Metro ready on :${METRO_PORT}"
      return 0
    fi
    sleep 1
    ((i++))
  done
  echo "[prepare-profile] Metro did not start — tail ${log_file}" >&2
  tail -n 30 "${log_file}" >&2 || true
  return 1
}

check_gateway() {
  if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
    echo "[prepare-profile] gateway healthy on :${GATEWAY_PORT}"
    return 0
  fi
  echo "[prepare-profile] WARNING: gateway not reachable on :${GATEWAY_PORT}" >&2
  return 1
}

if [[ "$MODE" == "full" ]]; then
  boot_ios_sim_if_needed
  if [[ -n "$SIM_NAME" ]]; then
    PLATFORM=ios DEVICE_MODE=simulator IOS_SIMULATOR="${SIM_NAME}" \
      METRO_PORT="${METRO_PORT}" GATEWAY_PORT="${GATEWAY_PORT}" \
      bash "${SCRIPT_DIR}/run-ios.sh"
  elif [[ -n "$ADB_TARGET" ]]; then
    PLATFORM=android DEVICE_MODE=device ADB_SERIAL="${ADB_TARGET}" \
      METRO_PORT="${METRO_PORT}" GATEWAY_PORT="${GATEWAY_PORT}" \
      bash "${SCRIPT_DIR}/run-android.sh"
  else
    echo "[prepare-profile] full requires IOS_SIMULATOR or ADB_SERIAL" >&2
    exit 1
  fi
else
  boot_ios_sim_if_needed
  start_metro_background
fi

check_gateway || true
metro_listening || {
  echo "[prepare-profile] Metro health check failed on :${METRO_PORT}" >&2
  exit 1
}

echo "[prepare-profile] ${MODE} complete"