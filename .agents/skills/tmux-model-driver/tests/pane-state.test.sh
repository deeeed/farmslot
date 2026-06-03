#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/pane-state.sh"

shell_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="zsh" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="shell" \
  TMUX_PANE_STATE_PANE_PID="123" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'user@host % ' \
  TMUX_PANE_STATE_LAST_LINE='user@host % ' \
  "$SCRIPT" "%1"
)"
printf '%s\n' "$shell_json" | grep -q '"state": "shell"'
printf '%s\n' "$shell_json" | grep -q '"confidence": "high"'

claude_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="claude" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="claude" \
  TMUX_PANE_STATE_PANE_PID="124" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'❯ ' \
  TMUX_PANE_STATE_LAST_LINE='❯ ' \
  "$SCRIPT" "%2"
)"
printf '%s\n' "$claude_json" | grep -q '"state": "claude"'
printf '%s\n' "$claude_json" | grep -q '"confidence": "high"'

fallback_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="" \
  TMUX_PANE_STATE_CURRENT_PATH="" \
  TMUX_PANE_STATE_SESSION_NAME="" \
  TMUX_PANE_STATE_PANE_TITLE="" \
  TMUX_PANE_STATE_PANE_PID="" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'recap:\n❯ ' \
  TMUX_PANE_STATE_LAST_LINE='❯ ' \
  "$SCRIPT" "%3"
)"
printf '%s\n' "$fallback_json" | grep -q '"state": "claude"'
printf '%s\n' "$fallback_json" | grep -q '"confidence": "low"'

unknown_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="" \
  TMUX_PANE_STATE_CURRENT_PATH="" \
  TMUX_PANE_STATE_SESSION_NAME="" \
  TMUX_PANE_STATE_PANE_TITLE="" \
  TMUX_PANE_STATE_PANE_PID="" \
  TMUX_PANE_STATE_TAIL_CAPTURE="" \
  TMUX_PANE_STATE_LAST_LINE="" \
  "$SCRIPT" "%4"
)"
printf '%s\n' "$unknown_json" | grep -q '"state": "unknown"'
printf '%s\n' "$unknown_json" | grep -q '"confidence": "low"'

echo "pane-state tests: ok"
