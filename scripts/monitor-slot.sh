#!/bin/bash
# monitor-slot.sh <slot-id>
# Checks worker progress: reads TASK.md status + last 30 lines of agent output.
#
# Usage:
#   bash scripts/monitor-slot.sh runner-mobile-1
set -euo pipefail

SLOT_ID="${1:?Usage: monitor-slot.sh <slot-id>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
load_project_config || true

banner "=== Monitor: ${SLOT_ID} on ${MACHINE} (${PLATFORM}) ==="
echo ""

# ── 1. TASK.md status ───────────────────────────────────────────────
header "TASK status"
TASK_HEAD=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
  "find '${REMOTE_REPO}/${WORKER_TASK_DIR_NAME:-${ARTIFACT_DIR:-.task}}' -name TASK.md -type f 2>/dev/null | head -1 | xargs head -20 2>/dev/null" 2>/dev/null || true)

if [ -z "$TASK_HEAD" ]; then
  info "No TASK.md found — slot may be idle"
else
  # Extract status line (case-insensitive grep for status/phase)
  STATUS_LINE=$(echo "$TASK_HEAD" | grep -i 'status\|phase' | head -3 || true)
  if [ -n "$STATUS_LINE" ]; then
    echo "$STATUS_LINE"
  else
    echo "  (no status line found in TASK.md header)"
  fi
fi

# ── 2. Git branch ──────────────────────────────────────────────────
header "Branch"
BRANCH=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
  "git -C '${REMOTE_REPO}' rev-parse --abbrev-ref HEAD 2>/dev/null" 2>/dev/null || echo "-")
echo "  ${BRANCH}"

# ── 3. Agent state (tmux) ──────────────────────────────────────────
header "Agent"
TMUX_EXISTS=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
  "tmux has-session -t '${SESSION}' 2>/dev/null && echo yes" 2>/dev/null || true)

if [ "$TMUX_EXISTS" != "yes" ]; then
  info "tmux session ${SESSION} not found"
else
  PANE_PID=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
    "tmux list-panes -t '${SESSION}' -F '#{pane_pid}' 2>/dev/null | head -1" 2>/dev/null || true)

  if [ -n "$PANE_PID" ]; then
    AGENT_RUNNING=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
      "pgrep -P '${PANE_PID}' -f 'claude|codex|opencode' >/dev/null 2>&1 && echo yes" 2>/dev/null || true)
    if [ "$AGENT_RUNNING" = "yes" ]; then
      echo -e "  ${YELLOW}Agent is running${NC}"
    else
      echo -e "  ${GREEN}Agent idle (no claude/codex/opencode process)${NC}"
    fi
  fi

  # Show last 30 lines
  header "Output (last 30 lines)"
  run_on "$HOST" "$MACHINE" "$SSH_USER" \
    "tmux capture-pane -p -J -t '${SESSION}' -S -30 2>/dev/null" 2>/dev/null || info "Could not capture pane"
fi

# ── 4. Token usage ──────────────────────────────────────────────────
header "Token usage"
USAGE_OUTPUT=$(bash "${SCRIPT_DIR}/session-usage.sh" "$SLOT_ID" report 2>/dev/null || \
               bash "${SCRIPT_DIR}/session-usage.sh" "$SLOT_ID" total 2>/dev/null || true)
if [ -n "$USAGE_OUTPUT" ]; then
  echo "$USAGE_OUTPUT"
else
  info "No usage data available"
fi
