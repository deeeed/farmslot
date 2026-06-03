#!/bin/bash
# soft-refresh-slot.sh — Reload the active extension page for a slot without full browser relaunch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

SLOT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) SLOT_ID="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

source "${SCRIPT_DIR}/lib/slot-common.sh"

if [[ -z "$SLOT_ID" ]]; then
  resolve_slot_by_repo "$(pwd)" || {
    echo "FAIL: could not infer slot from current repo; pass --slot <id>" >&2
    exit 1
  }
  SLOT_ID=$(parse_slot "d['slot']['id']")
fi

load_slot_vars "$SLOT_ID"
check_slot_enabled || exit 0
load_project_config || { echo "FAIL: no project config for ${PROJECT_NAME}" >&2; exit 1; }

REPO_DIR="${REMOTE_REPO}"
# Harness injection root — keep in sync with the skill's RECIPE_HARNESS_ROOT
# (path.sh default). Configurable, not hardcoded.
HARNESS_ROOT="${RECIPE_HARNESS_ROOT:-temp/agentic/recipe-harness}"
# Mirror the skill's path.sh validation: relative, safe charset, no '.'/'..' components,
# so a hostile RECIPE_HARNESS_ROOT can't escape REPO_DIR.
case "$HARNESS_ROOT" in ""|/*|*[!A-Za-z0-9._/-]*) echo "FAIL: invalid RECIPE_HARNESS_ROOT: '$HARNESS_ROOT'" >&2; exit 1 ;; esac
case "/$HARNESS_ROOT/" in */../*|*/./*) echo "FAIL: RECIPE_HARNESS_ROOT must not contain '.'/'..' components" >&2; exit 1 ;; esac
SCRIPT_PATH="${REPO_DIR}/${HARNESS_ROOT}/extension/runner/recipes/soft-refresh.js"

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "FAIL: soft-refresh.js not found at ${SCRIPT_PATH}" >&2
  echo "Run: bash ${SCRIPT_DIR}/sync-fixtures.sh --slot ${SLOT_ID}" >&2
  exit 1
fi

cd "${REPO_DIR}/${HARNESS_ROOT}/extension/runner/recipes"
node soft-refresh.js --cdp-port "${CDP_PORT}" --slot-id "${SLOT_ID}"
