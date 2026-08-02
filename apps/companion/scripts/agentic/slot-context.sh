#!/usr/bin/env bash
# Resolve Companion device + Metro ownership from the Farmslot slot contract.

companion_apply_farmslot_slot_context() {
  local requested_platform="${1:-}"
  [[ -n "${FARMSLOT_SLOT_ID:-}" ]] || return 0

  local app_dir repo_root farmslot_bin slot_vars normalized
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  repo_root="$(cd "${app_dir}/../.." && pwd)"
  farmslot_bin="${FARMSLOT_BIN:-${repo_root}/node_modules/.bin/farmslot}"
  if [[ ! -x "${farmslot_bin}" ]]; then
    echo "ERROR: Farmslot CLI not found at ${farmslot_bin}." >&2
    return 1
  fi

  slot_vars="$("${farmslot_bin}" internal slot-vars "${FARMSLOT_SLOT_ID}" --shell)" || {
    echo "ERROR: could not resolve slot ${FARMSLOT_SLOT_ID}." >&2
    return 1
  }
  normalized="$(SLOT_VARS_SHELL="${slot_vars}" bash -c '
    eval "$SLOT_VARS_SHELL"
    printf "COMPANION_SLOT_IOS=%q\n" "${IOS_SIMULATOR:-${SIMULATOR:-}}"
    printf "COMPANION_SLOT_ANDROID=%q\n" "${ADB_SERIAL:-}"
    printf "COMPANION_SLOT_METRO=%q\n" "${METRO_PORT:-}"
  ')" || return 1
  eval "${normalized}"

  if [[ ! "${COMPANION_SLOT_METRO}" =~ ^[0-9]+$ || "${COMPANION_SLOT_METRO}" == "8081" ]]; then
    echo "ERROR: slot ${FARMSLOT_SLOT_ID} needs a unique non-default METRO_PORT (got '${COMPANION_SLOT_METRO:-unset}')." >&2
    return 1
  fi
  # An explicit slot owns its runtime resources. Replace checkout-local defaults
  # so a recipe cannot drift onto another slot's Metro server or device.
  case "${requested_platform}" in
    ios)
      if [[ -z "${COMPANION_SLOT_IOS}" ]]; then
        echo "ERROR: slot ${FARMSLOT_SLOT_ID} has no assigned iOS simulator." >&2
        return 1
      fi
      IOS_SIMULATOR="${COMPANION_SLOT_IOS}"
      SIMULATOR="${COMPANION_SLOT_IOS}"
      IOS_DEVICE_UDID=""
      export IOS_SIMULATOR SIMULATOR IOS_DEVICE_UDID
      ;;
    android)
      if [[ -z "${COMPANION_SLOT_ANDROID}" ]]; then
        echo "ERROR: slot ${FARMSLOT_SLOT_ID} has no assigned Android device." >&2
        return 1
      fi
      ANDROID_DEVICE="${COMPANION_SLOT_ANDROID}"
      ADB_SERIAL="${COMPANION_SLOT_ANDROID}"
      ANDROID_SERIAL="${COMPANION_SLOT_ANDROID}"
      export ANDROID_DEVICE ADB_SERIAL ANDROID_SERIAL
      ;;
    metro)
      ;;
    *)
      echo "ERROR: slot-owned Companion launch requires platform ios, android, or metro (got '${requested_platform:-unset}')." >&2
      return 1
      ;;
  esac

  METRO_PORT="${COMPANION_SLOT_METRO}"
  export FARMSLOT_SLOT_ID METRO_PORT
}
