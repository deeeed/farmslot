#!/bin/bash
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: pane-state.sh <pane-id> [runner-id]" >&2
  exit 1
fi

pane_id="$1"
runner_id="${2:-}"

resolve_override() {
  local name="$1"
  local fallback="$2"
  if [ -n "${!name+x}" ]; then
    printf '%s' "${!name}"
  else
    printf '%s' "$fallback"
  fi
}

current_command="$(resolve_override TMUX_PANE_STATE_CURRENT_COMMAND "$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)")"
current_path="$(resolve_override TMUX_PANE_STATE_CURRENT_PATH "$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)")"
session_name="$(resolve_override TMUX_PANE_STATE_SESSION_NAME "$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)")"
pane_title="$(resolve_override TMUX_PANE_STATE_PANE_TITLE "$(tmux display-message -p -t "$pane_id" '#{pane_title}' 2>/dev/null || true)")"
pane_pid="$(resolve_override TMUX_PANE_STATE_PANE_PID "$(tmux display-message -p -t "$pane_id" '#{pane_pid}' 2>/dev/null || true)")"
foreground_commands="$(resolve_override TMUX_PANE_STATE_FOREGROUND_COMMANDS "$({
  foreground_pgid="$(ps -o tpgid= -p "$pane_pid" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$foreground_pgid" ]; then
    ps -o comm= -g "$foreground_pgid" 2>/dev/null || true
  fi
})")"
tail_capture="$(resolve_override TMUX_PANE_STATE_TAIL_CAPTURE "$(tmux capture-pane -pt "$pane_id" -S -12 2>/dev/null || true)")"
if [ -n "${TMUX_PANE_STATE_LAST_LINE+x}" ]; then
  last_line="$TMUX_PANE_STATE_LAST_LINE"
else
  last_line="$(printf '%s\n' "$tail_capture" | awk 'NF { line=$0 } END { print line }')"
fi

state="unknown"
phase="idle"
confidence="low"
reasons=""

python3 - <<'PY' "$pane_id" "$session_name" "$current_command" "$current_path" "$pane_title" "$pane_pid" "$foreground_commands" "$tail_capture" "$last_line" "$runner_id"
import json, re, sys

pane_id, session_name, current_command, current_path, pane_title, pane_pid, foreground_commands, tail_capture, last_line, runner_id = sys.argv[1:]

def command_basenames(commands: str):
    return {command.rsplit('/', 1)[-1] for command in commands.splitlines() if command.strip()}

def classify_state(current_command: str, foreground_commands: str, tail: str, last_line: str):
    state = "unknown"
    confidence = "low"
    reasons = []

    foreground = command_basenames(foreground_commands)
    if foreground & {"claude", "claude.exe", "claude_exe"}:
        return "claude", "high", ["foreground process group contains Claude"]
    if "codex" in foreground:
        return "codex", "high", ["foreground process group contains Codex"]
    if "grok" in foreground:
        return "grok", "high", ["foreground process group contains Grok"]
    if foreground & {"cursor-agent", "agent"}:
        return "cursor", "high", ["foreground process group contains Cursor"]

    shell_cmds = {"zsh", "bash", "sh", "fish"}
    if current_command in shell_cmds:
        state = "shell"
        confidence = "high"
        reasons.append("exact pane_current_command indicates shell")
        return state, confidence, reasons

    if current_command in {"claude", "claude.exe", "claude_exe"}:
        return "claude", "high", [f"exact pane_current_command={current_command}"]

    if current_command == "codex":
        return "codex", "high", ["exact pane_current_command=codex"]

    codex_hints = bool(
        re.search(r"(?:^|\n)\s*›\s|\bgpt-[\w.-]+\s+(?:low|medium|high|max)\b|\bWorking \(", tail)
    )
    if current_command == "node" and codex_hints:
        return "codex", "medium", ["pane_current_command=node with Codex-style tail hints"]

    if current_command == "grok":
        return "grok", "high", ["exact pane_current_command=grok"]

    if current_command in {"cursor-agent", "agent"}:
        return "cursor", "high", [f"exact pane_current_command={current_command}"]

    semver_like = bool(re.fullmatch(r"\d+\.\d+\.\d+", current_command or ""))
    claude_hints = bool(re.search(r"Press Ctrl-C again to exit|/model|Cogitated|Baked for|Unfurling|Shimmying|recap:", tail))
    if semver_like and claude_hints:
        return "claude", "medium", ["semver-like pane_current_command with Claude-style tail hints"]

    grok_hints = bool(
        re.search(
            r"run grok build in a project directory|enter:submit|grok build",
            tail,
            flags=re.I,
        )
    )
    if grok_hints:
        return "grok", "medium", ["Grok-style tail hints"]

    cursor_hints = bool(re.search(r"\[a\] trust this workspace|\[q\] quit", tail, flags=re.I))
    if cursor_hints:
        return "cursor", "medium", ["Cursor workspace-trust tail hints"]

    prompt_hint = bool(re.search(r"(^| )❯ ?$|Press Ctrl-C again to exit|/model|recap:", tail))
    if prompt_hint:
        return "claude", "low", ["text-only Claude-style prompt/tail hint"]

    if pane_pid:
        reasons.append("pane metadata present but no confident state match")
    if not current_command and not tail:
        reasons.append("no tmux metadata available for this pane")
    return state, confidence, reasons

def normalize_runner(value: str) -> str:
    return (value or "").strip().lower()

def effective_runner(state: str, runner_id: str) -> str:
    explicit = normalize_runner(runner_id)
    if explicit:
        return explicit
    if state in {"grok", "cursor"}:
        return state
    return ""

def detect_mcp_init(tail: str, runner: str):
    if runner != "grok":
        return None, None
    match = re.search(r"\bmcp\s*\(\s*(\d+)\s*/\s*(\d+)\s*\)", tail, flags=re.I)
    if not match:
        return None, None
    ready = int(match.group(1))
    total = int(match.group(2))
    if total > 0 and ready < total:
        return "mcp-init", None
    return None, None

def detect_cold_start(tail: str, runner: str):
    if runner != "grok":
        return None, None
    if re.search(r"starting session", tail, flags=re.I):
        return "cold-start", None
    return None, None

def detect_launch_blocker(tail: str, runner: str):
    lower = tail.lower()
    if runner == "cursor" and (
        "[a] trust this workspace" in lower
        and "[q] quit" in lower
        and "use arrow keys to navigate" in lower
    ):
        return "workspace-trust", "cursor-trust-workspace"
    if runner == "grok" and (
        "run grok build in a project directory" in lower
        and "(current)" in lower
        and "enter:submit" in lower
    ):
        return "project-directory", "grok-select-current-project"
    mcp_blocker, mcp_action = detect_mcp_init(tail, runner)
    if mcp_blocker:
        return mcp_blocker, mcp_action
    cold_blocker, cold_action = detect_cold_start(tail, runner)
    if cold_blocker:
        return cold_blocker, cold_action
    if runner:
        for line in tail.split("\n"):
            line_lower = line.strip().lower()
            if not line_lower:
                continue
            if re.search(r"\bmcp\b", line_lower):
                continue
            if re.search(r"\b(login|log in|authenticate|authentication|auth)\b", line_lower) and re.search(
                r"\b(expired|required|failed|please|needed|unauthorized|not authenticated|not logged in)\b",
                line_lower,
            ):
                return "auth-required", None
    return None, None

def classify_phase(tail: str, launch_blocker):
    if launch_blocker:
        return "launch-blocker", ["runner launch blocker visible in pane tail"]
    if re.search(
        r"still waiting for first runner output|Baked for|Shimmying|Proofing|Thinking|Unfurling|Drizzling|Cooking|Pollinating|Effecting|Working \(|[✢✶✽✻·]\s+[A-Za-z][A-Za-z -]*…\s+\(",
        tail,
    ):
        return "busy", ["busy phrase present in pane tail"]
    return "idle", []

state, confidence, reasons = classify_state(current_command, foreground_commands, tail_capture, last_line)
runner = effective_runner(state, runner_id)
launch_blocker, auto_action = detect_launch_blocker(tail_capture, runner)
if runner:
    reasons.append(f"launch-blocker scope runner={runner}")
phase, phase_reasons = classify_phase(tail_capture, launch_blocker)
reasons.extend(phase_reasons)

print(json.dumps({
    "pane_id": pane_id,
    "session_name": session_name,
    "current_command": current_command,
    "current_path": current_path,
    "pane_title": pane_title,
    "pane_pid": pane_pid,
    "foreground_commands": foreground_commands.splitlines(),
    "state": state,
    "phase": phase,
    "confidence": confidence,
    "reasons": reasons,
    "launch_blocker": launch_blocker,
    "auto_action": auto_action,
    "tail": tail_capture,
    "last_line": last_line,
}, indent=2))
PY
