#!/usr/bin/env bash
# Shared helpers for companion local-device scripts. Source this file; do not run it.

companion_detect_lan_host() {
  if [[ -n "${REACT_NATIVE_PACKAGER_HOSTNAME:-}" ]]; then
    printf '%s\n' "${REACT_NATIVE_PACKAGER_HOSTNAME}"
    return 0
  fi

  local default_iface=""
  if command -v route >/dev/null 2>&1; then
    default_iface="$(route get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  fi

  if [[ -n "${default_iface}" ]] && command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr "${default_iface}" 2>/dev/null && return 0
  fi

  if command -v scutil >/dev/null 2>&1; then
    local scutil_address
    scutil_address="$(
      scutil --nwi 2>/dev/null | awk '
        $3 == "flags" {
          iface=$1
          sub(/:$/, "", iface)
          skip=(iface ~ /^(utun|lo|awdl|llw)/)
        }
        $1 == "address" && !skip {
          print $3
          exit
        }
      '
    )"
    if [[ -n "${scutil_address}" ]]; then
      printf '%s\n' "${scutil_address}"
      return 0
    fi
  fi

  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2 en3 en4 en5 en6 en7 en8 en9 en10; do
      ipconfig getifaddr "${iface}" 2>/dev/null && return 0
    done
  fi

  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1; exit}' && return 0
  fi

  return 1
}

companion_load_local_auth_env() {
  local repo_dir
  repo_dir="$(cd "${APP_DIR}/../.." && pwd)"
  local auth_env="${repo_dir}/.env.local-auth"
  if [[ -f "${auth_env}" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${auth_env}"
    set +a
  fi
}

companion_default_metro_connection() {
  case "${DEVICE_MODE:-auto}" in
    simulator|emulator)
      printf 'localhost\n'
      ;;
    auto)
      if [[ -n "${IOS_SIMULATOR:-${SIMULATOR:-}}" && -z "${IOS_DEVICE_UDID:-}" && -z "${ANDROID_DEVICE:-${ADB_SERIAL:-${ANDROID_SERIAL:-}}}" ]]; then
        printf 'localhost\n'
      else
        printf 'lan\n'
      fi
      ;;
    select|device|*)
      printf 'lan\n'
      ;;
  esac
}

companion_configure_network_env() {
  local metro_connection="${METRO_CONNECTION:-auto}"
  local gateway_port="${GATEWAY_PORT:?GATEWAY_PORT must come from slot/worktree config}"
  COMPANION_PACKAGER_HOSTNAME="${REACT_NATIVE_PACKAGER_HOSTNAME:-}"
  COMPANION_GATEWAY_URL="${EXPO_PUBLIC_GATEWAY_URL:-}"

  if [[ "${metro_connection}" == "auto" ]]; then
    metro_connection="$(companion_default_metro_connection)"
  fi
  METRO_CONNECTION="${metro_connection}"

  if [[ "${metro_connection}" == "localhost" ]]; then
    COMPANION_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME:-localhost}"
    if [[ -z "${COMPANION_GATEWAY_URL}" ]]; then
      COMPANION_GATEWAY_URL="ws://localhost:${gateway_port}/ws"
    fi
  elif [[ "${metro_connection}" == "lan" ]]; then
    COMPANION_PACKAGER_HOSTNAME="${COMPANION_PACKAGER_HOSTNAME:-$(companion_detect_lan_host || true)}"
    if [[ -z "${COMPANION_PACKAGER_HOSTNAME}" ]]; then
      echo "ERROR: could not auto-detect LAN IP. Set REACT_NATIVE_PACKAGER_HOSTNAME in scripts/agentic/agentic.local.conf." >&2
      return 1
    fi
    local gateway_host="${COMPANION_GATEWAY_HOST:-${COMPANION_PACKAGER_HOSTNAME}}"
    if [[ -z "${COMPANION_GATEWAY_URL}" || "${COMPANION_GATEWAY_URL}" == ws://localhost:* || "${COMPANION_GATEWAY_URL}" == ws://127.0.0.1:* ]]; then
      COMPANION_GATEWAY_URL="ws://${gateway_host}:${gateway_port}/ws"
    fi
  else
    echo "ERROR: unsupported METRO_CONNECTION '${metro_connection}' (expected 'auto', 'lan', or 'localhost')." >&2
    return 1
  fi

  export METRO_CONNECTION COMPANION_PACKAGER_HOSTNAME COMPANION_GATEWAY_URL
}
