#!/bin/bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: pane-state.sh <pane-id>" >&2
  exit 1
fi

pane_id="$1"
current_command="${TMUX_PANE_STATE_CURRENT_COMMAND:-$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)}"
current_path="${TMUX_PANE_STATE_CURRENT_PATH:-$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)}"
session_name="${TMUX_PANE_STATE_SESSION_NAME:-$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)}"
pane_title="${TMUX_PANE_STATE_PANE_TITLE:-$(tmux display-message -p -t "$pane_id" '#{pane_title}' 2>/dev/null || true)}"
pane_pid="${TMUX_PANE_STATE_PANE_PID:-$(tmux display-message -p -t "$pane_id" '#{pane_pid}' 2>/dev/null || true)}"
tail_capture="${TMUX_PANE_STATE_TAIL_CAPTURE:-$(tmux capture-pane -pt "$pane_id" -S -12 2>/dev/null || true)}"
last_line="${TMUX_PANE_STATE_LAST_LINE:-$(printf '%s\n' "$tail_capture" | awk 'NF { line=$0 } END { print line }')}"

state="unknown"
phase="idle"
confidence="low"
reasons=""

python3 - <<'PY' "$pane_id" "$session_name" "$current_command" "$current_path" "$pane_title" "$pane_pid" "$tail_capture" "$last_line"
import json, re, sys

pane_id, session_name, current_command, current_path, pane_title, pane_pid, tail_capture, last_line = sys.argv[1:]

def classify_state(current_command: str, tail: str, last_line: str):
    state = "unknown"
    confidence = "low"
    reasons = []

    shell_cmds = {"zsh", "bash", "sh", "fish"}
    if current_command in shell_cmds:
        state = "shell"
        confidence = "high"
        reasons.append("exact pane_current_command indicates shell")
        return state, confidence, reasons

    if current_command == "claude":
        return "claude", "high", ["exact pane_current_command=claude"]

    if current_command == "codex":
        return "codex", "high", ["exact pane_current_command=codex"]

    semver_like = bool(re.fullmatch(r"\d+\.\d+\.\d+", current_command or ""))
    claude_hints = bool(re.search(r"Press Ctrl-C again to exit|/model|Cogitated|Baked for|Unfurling|Shimmying|recap:", tail))
    if semver_like and claude_hints:
        return "claude", "medium", ["semver-like pane_current_command with Claude-style tail hints"]

    prompt_hint = bool(re.search(r"(^| )❯ ?$|Press Ctrl-C again to exit|/model|recap:", tail))
    if prompt_hint:
        return "claude", "low", ["text-only Claude-style prompt/tail hint"]

    if pane_pid:
        reasons.append("pane metadata present but no confident state match")
    if not current_command and not tail:
        reasons.append("no tmux metadata available for this pane")
    return state, confidence, reasons

def classify_phase(tail: str):
    if re.search(r"still waiting for first runner output|Baked for|Shimmying|Proofing|Thinking|Unfurling", tail):
        return "busy", ["busy phrase present in pane tail"]
    return "idle", []

state, confidence, reasons = classify_state(current_command, tail_capture, last_line)
phase, phase_reasons = classify_phase(tail_capture)
reasons.extend(phase_reasons)

print(json.dumps({
    "pane_id": pane_id,
    "session_name": session_name,
    "current_command": current_command,
    "current_path": current_path,
    "pane_title": pane_title,
    "pane_pid": pane_pid,
    "state": state,
    "phase": phase,
    "confidence": confidence,
    "reasons": reasons,
    "tail": tail_capture,
    "last_line": last_line,
}, indent=2))
PY
