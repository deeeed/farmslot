#!/bin/bash
# reopen-slot-browser.sh — Reopen a project's prepared browser for continued work.
# Can be run from anywhere with --slot, or from inside a slot repo (auto-detect).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

SLOT_ID=""
REPO_DIR=""
RUNTIME_DIR=""
CDP_PORT_ARG=""
WATCHER_PORT_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) SLOT_ID="$2"; shift 2 ;;
    --repo) REPO_DIR="$2"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="$2"; shift 2 ;;
    --cdp-port) CDP_PORT_ARG="$2"; shift 2 ;;
    --watcher-port) WATCHER_PORT_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

source "${SCRIPT_DIR}/lib/slot-common.sh"

if [[ -z "$SLOT_ID" ]]; then
  TARGET_DIR="${REPO_DIR:-$(pwd)}"
  resolve_slot_by_repo "$TARGET_DIR" || {
    echo "FAIL: could not infer slot from repo path '${TARGET_DIR}'. Pass --slot <id>." >&2
    exit 1
  }
  SLOT_ID=$(parse_slot "d['slot']['id']")
fi

load_slot_vars "$SLOT_ID"
check_slot_enabled || exit 0
load_project_config || { echo "FAIL: no project config for ${PROJECT_NAME}" >&2; exit 1; }

REPO_DIR="${REPO_DIR:-${REMOTE_REPO}}"
RUNTIME_DIR="${RUNTIME_DIR:-${RUNTIME_DIR:-.agent}}"
CDP_PORT="${CDP_PORT_ARG:-${CDP_PORT:-}}"
WATCHER_PORT="${WATCHER_PORT_ARG:-${WATCHER_PORT:-}}"

REOPEN_SCRIPT="${REPO_DIR}/${RUNTIME_DIR}/reopen-browser.sh"

if [[ ! -f "$REOPEN_SCRIPT" ]]; then
  echo "FAIL: reopen script not found at ${REOPEN_SCRIPT}" >&2
  echo "Run: bash ${SCRIPT_DIR}/sync-fixtures.sh --slot ${SLOT_ID}" >&2
  exit 1
fi

echo "[reopen-slot-browser] slot=${SLOT_ID}"
echo "[reopen-slot-browser] repo=${REPO_DIR}"
echo "[reopen-slot-browser] cdp=${CDP_PORT:-unset}"
echo "[reopen-slot-browser] runtime=${RUNTIME_DIR}"

bash "$REOPEN_SCRIPT" \
  --slot-id "$SLOT_ID" \
  --repo "$REPO_DIR" \
  ${CDP_PORT:+--cdp-port "$CDP_PORT"} \
  --runtime-dir "$RUNTIME_DIR" \
  ${WATCHER_PORT:+--watcher-port "$WATCHER_PORT"}
