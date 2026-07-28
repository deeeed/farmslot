#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./agentic.conf
source "${SCRIPT_DIR}/agentic.conf"

RECIPE_BIN="${COMPANION_EXPO_RECIPE_BIN:-farmslot-expo-recipe}"
exec "${RECIPE_BIN}" "$@"
