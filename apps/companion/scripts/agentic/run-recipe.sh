#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"
# shellcheck source=./slot-context.sh
source "${SCRIPT_DIR}/slot-context.sh"

case "${PLATFORM:-}" in
  ios | android | metro)
    companion_apply_farmslot_slot_context "${PLATFORM}"
    ;;
esac
export FARMSLOT_RECIPE_APP_ID="${FARMSLOT_RECIPE_APP_ID:-${BUNDLE_ID}}"

RECIPE_BIN="${COMPANION_EXPO_RECIPE_BIN:-farmslot-expo-recipe}"
exec "${RECIPE_BIN}" "$@"
