#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EAS_DIR="${APP_DIR}/.eas"
LINK_PATH="${EAS_DIR}/google-play-service-account.json"
SOURCE_PATH="${FARMSLOT_PLAY_SERVICE_ACCOUNT_KEY:-${HOME}/.config/farmslot/secrets/farmslot-play-publisher.json}"

if [[ ! -f "${SOURCE_PATH}" ]]; then
  echo "ERROR: Google Play service account key not found at:" >&2
  echo "  ${SOURCE_PATH}" >&2
  echo "Create it or set FARMSLOT_PLAY_SERVICE_ACCOUNT_KEY to the JSON key path." >&2
  exit 1
fi

mkdir -p "${EAS_DIR}"

if [[ -L "${LINK_PATH}" ]]; then
  current_target="$(readlink "${LINK_PATH}")"
  if [[ "${current_target}" == "${SOURCE_PATH}" ]]; then
    echo "[release] Play service account: ${SOURCE_PATH}"
    exit 0
  fi
  rm "${LINK_PATH}"
elif [[ -e "${LINK_PATH}" ]]; then
  echo "ERROR: ${LINK_PATH} exists and is not a symlink; remove it manually." >&2
  exit 1
fi

ln -s "${SOURCE_PATH}" "${LINK_PATH}"
echo "[release] Linked Play service account: ${LINK_PATH} -> ${SOURCE_PATH}"