#!/bin/bash
# auto-refresh-slot.sh — Opt-in auto refresh monitor for a slot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

SLOT_ID=""
ACTION="start"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) SLOT_ID="$2"; shift 2 ;;
    --stop) ACTION="stop"; shift ;;
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
SESSION="autorefresh-${SLOT_ID//[^[:alnum:]]/-}"
load_project_config || { echo "FAIL: no project config for ${PROJECT_NAME}" >&2; exit 1; }
AUTO_REFRESH_SCRIPT="${PROJECT_DIR}/projects/${PROJECT_NAME}/setup/auto-refresh.sh"

if [[ ! -x "$AUTO_REFRESH_SCRIPT" ]]; then
  echo "FAIL: auto refresh script not found for project ${PROJECT_NAME}: ${AUTO_REFRESH_SCRIPT}" >&2
  exit 1
fi

if [[ "$ACTION" == "stop" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "[auto-refresh-slot] stopped ${SESSION}"
  exit 0
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" \
  "cd '${PROJECT_DIR}' && exec bash '${AUTO_REFRESH_SCRIPT}' --slot-id '${SLOT_ID}' --repo '${REMOTE_REPO}' --cdp-port '${CDP_PORT}'"
echo "[auto-refresh-slot] started ${SESSION}"
