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

claude_exe_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="claude_exe" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="claude" \
  TMUX_PANE_STATE_PANE_PID="124" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'✶ Drizzling…\n❯ ' \
  TMUX_PANE_STATE_LAST_LINE='❯ ' \
  "$SCRIPT" "%2a"
)"
printf '%s\n' "$claude_exe_json" | grep -q '"state": "claude"'
printf '%s\n' "$claude_exe_json" | grep -q '"confidence": "high"'
printf '%s\n' "$claude_exe_json" | grep -q '"phase": "busy"'

codex_node_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="node" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="codex" \
  TMUX_PANE_STATE_PANE_PID="124" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'› Summarize recent commits\n\n  gpt-5.6-sol high fast · /tmp' \
  TMUX_PANE_STATE_LAST_LINE='gpt-5.6-sol high fast · /tmp' \
  "$SCRIPT" "%2b"
)"
printf '%s\n' "$codex_node_json" | grep -q '"state": "codex"'
printf '%s\n' "$codex_node_json" | grep -q '"confidence": "medium"'

generic_node_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="node" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="server" \
  TMUX_PANE_STATE_PANE_PID="124" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'server listening on port 3000' \
  TMUX_PANE_STATE_LAST_LINE='server listening on port 3000' \
  "$SCRIPT" "%2c"
)"
printf '%s\n' "$generic_node_json" | grep -q '"state": "unknown"'

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

grok_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="grok" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp/repo" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="grok" \
  TMUX_PANE_STATE_PANE_PID="125" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'Run Grok Build in a project directory?\nEnter:submit' \
  TMUX_PANE_STATE_LAST_LINE='Enter:submit' \
  "$SCRIPT" "%5"
)"
printf '%s\n' "$grok_json" | grep -q '"state": "grok"'
printf '%s\n' "$grok_json" | grep -q '"confidence": "high"'

grok_blocker_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="grok" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp/repo" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="grok" \
  TMUX_PANE_STATE_PANE_PID="126" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'Run Grok Build in a project directory?\n1 (○) farmslot (current)\nEnter:submit' \
  TMUX_PANE_STATE_LAST_LINE='Enter:submit' \
  "$SCRIPT" "%6"
)"
printf '%s\n' "$grok_blocker_json" | grep -q '"launch_blocker": "project-directory"'
printf '%s\n' "$grok_blocker_json" | grep -q '"auto_action": "grok-select-current-project"'
printf '%s\n' "$grok_blocker_json" | grep -q '"phase": "launch-blocker"'

cursor_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="cursor-agent" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp/repo" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="cursor" \
  TMUX_PANE_STATE_PANE_PID="127" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'[a] trust this workspace\n[q] quit\nuse arrow keys to navigate' \
  TMUX_PANE_STATE_LAST_LINE='use arrow keys to navigate' \
  "$SCRIPT" "%7"
)"
printf '%s\n' "$cursor_json" | grep -q '"state": "cursor"'
printf '%s\n' "$cursor_json" | grep -q '"launch_blocker": "workspace-trust"'
printf '%s\n' "$cursor_json" | grep -q '"auto_action": "cursor-trust-workspace"'

cross_runner_json="$(
  TMUX_PANE_STATE_CURRENT_COMMAND="zsh" \
  TMUX_PANE_STATE_CURRENT_PATH="/tmp" \
  TMUX_PANE_STATE_SESSION_NAME="demo" \
  TMUX_PANE_STATE_PANE_TITLE="shell" \
  TMUX_PANE_STATE_PANE_PID="128" \
  TMUX_PANE_STATE_TAIL_CAPTURE=$'Run Grok Build in a project directory?\n1 (○) farmslot (current)\nEnter:submit' \
  TMUX_PANE_STATE_LAST_LINE='Enter:submit' \
  "$SCRIPT" "%8" "cursor"
)"
printf '%s\n' "$cross_runner_json" | grep -q '"launch_blocker": null'

echo "pane-state tests: ok"
