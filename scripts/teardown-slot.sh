#!/bin/bash
# teardown-slot.sh <slot-id> [--kill-tmux]
# Gateway-free slot teardown. Calls hooks.teardown directly via bash, so it
# works even when the farmslot gateway / command-center daemon is down — which
# is exactly when you usually need to clean up an orphaned slot.
#
# What it does (in order):
#   1. resolve_slot → load_slot_vars   (pool/<machine>.json → PORT, SIMULATOR, …)
#   2. load_project_config             (projects/<name>/project.json → hooks)
#   3. teardown_slot_infra             (runs expanded hooks.teardown in REMOTE_REPO)
#   4. optional --kill-tmux            (close the slot's tmux session)
#
# Usage:
#   bash scripts/teardown-slot.sh runner-mobile-3
#   bash scripts/teardown-slot.sh runner-mobile-3 --kill-tmux
set -euo pipefail

SLOT_ID="${1:?Usage: teardown-slot.sh <slot-id> [--kill-tmux]}"
shift

KILL_TMUX=false
for arg in "$@"; do
  case "$arg" in
    --kill-tmux) KILL_TMUX=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"
FARMSLOT_DIR="${PROJECT_DIR}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/slot-common.sh"

load_slot_vars "$SLOT_ID"
load_project_config

banner "Teardown ${SLOT_ID}"
info "  repo=${REMOTE_REPO}"
info "  session=${SESSION}"
[ -n "${PORT:-}" ] && info "  port=${PORT}"
[ -n "${SIMULATOR:-}" ] && info "  simulator=${SIMULATOR}"

teardown_slot_infra

if [ "$KILL_TMUX" = true ]; then
  if run_on "$HOST" "$MACHINE" "$SSH_USER" "tmux has-session -t '${SESSION}' 2>/dev/null"; then
    if run_on "$HOST" "$MACHINE" "$SSH_USER" "tmux kill-session -t '${SESSION}'" 2>/dev/null; then
      pass "tmux session ${SESSION} killed"
    else
      fail "tmux session ${SESSION} existed but could not be killed"
      exit 1
    fi
  else
    info "  tmux session ${SESSION} not present — skip"
  fi
fi
