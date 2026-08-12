#!/bin/bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 4 ]; then
  echo "usage: send-and-verify.sh <pane-id> <action-kind> [trace.jsonl] [capture-lines]" >&2
  exit 1
fi

pane_id="$1"
action_kind="$2"
trace_path="${3:-}"
capture_lines="${4:--15}"
payload="$(cat)"

skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
pane_state_script="${TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT:-$skill_dir/scripts/pane-state.sh}"
before_json="$("$pane_state_script" "$pane_id")"
before_state="$(python3 - <<'PY' "$before_json"
import json, sys
print(json.loads(sys.argv[1])["state"])
PY
)"

submit_key_for_action() {
  if [ "$1" = "shell" ]; then
    echo "C-m"
    return
  fi
  node --import tsx "$skill_dir/scripts/runner-submit-key.mjs" "$1"
}

submit_key_for_pane() {
  local action="$1"
  local tail="$2"
  if [ "$action" = "codex" ] && printf '%s' "$tail" | grep -qi 'tab to queue message'; then
    echo "Tab"
    return
  fi
  submit_key_for_action "$action"
}

classify_verification() {
  local payload="$1"
  local action="$2"
  local before_json="$3"
  local after_json="$4"
  python3 - <<'PY' "$payload" "$action" "$before_json" "$after_json"
import json, re, sys
payload = sys.argv[1].strip()
action = sys.argv[2]
before = json.loads(sys.argv[3])
after = json.loads(sys.argv[4])
before_tail = before.get("tail") or ""
last_line = (after.get("last_line") or "").strip()
tail = after.get("tail") or ""
model_actions = {"claude", "codex", "grok", "cursor"}
patterns = {
    "claude": r"Cooking|Pollinating|Effecting|Unfurling|Baked for|⏺\s|Reading \d+ files?|[✢✶✽✻·]\s+[A-Za-z][A-Za-z -]*…\s+\(",
    "codex": r"Working \(|• (?:Ran|Explored|Running|Reading|Called|Searched)|Running (?:PreToolUse|UserPromptSubmit) hook",
    "grok": r"Thinking|Working \(|Reading \d+ files?",
    "cursor": r"Thinking|Working \(|Generating|Reading \d+ files?",
}
progress_pattern = patterns.get(action, r"Working \(")

if (
    action in model_actions
    and re.match(r"^/(?:exit|quit)\b", payload)
    and before.get("state") == action
    and after.get("state") == "shell"
):
    print("submitted")
elif after.get("phase") == "launch-blocker":
    print("launch_blocker")
elif action == "shell":
    delivered = (payload and payload in tail) or tail != before_tail or (
        after.get("state") != before.get("state")
    )
    print("submitted" if delivered else "unverified")
elif payload and payload in tail:
    after_payload = tail.rsplit(payload, 1)[-1]
    if re.search(progress_pattern, after_payload) or (
        action == "claude" and re.search(r"(?:^|\n)\s*❯\s*$", after_payload)
    ):
        print("submitted")
    elif "ctrl+g to edit in Nvim" in last_line or "ctrl+g to edit in Nvim" in after_payload:
        print("input_buffered")
    elif payload in last_line:
        print("pending_input")
    else:
        print("input_buffered")
elif action in model_actions:
    before_progress = len(re.findall(progress_pattern, before_tail))
    after_progress = len(re.findall(progress_pattern, tail))
    phase_started = after.get("phase") == "busy" and before.get("phase") != "busy"
    if phase_started or after_progress > before_progress:
        print("submitted")
    else:
        print("unverified")
else:
    print("unverified")
PY
}

if [ "$action_kind" = "shell" ] && [ "$before_state" != "shell" ]; then
  verification="shell_launch_blocked"
else
  tmux send-keys -t "$pane_id" -l "$payload"
  after_json="$("$pane_state_script" "$pane_id")"
  tail="$(python3 - <<'PY' "$after_json"
import json, sys
print(json.loads(sys.argv[1]).get("tail") or "")
PY
)"
  submit_key="$(submit_key_for_pane "$action_kind" "$tail")"
  tmux send-keys -t "$pane_id" "$submit_key"
  verification="unverified"
  attempts=1
  case "$action_kind" in
    claude | codex | grok | cursor) attempts=3 ;;
  esac
  for _ in $(seq 1 "$attempts"); do
    sleep 1
    after_json="$("$pane_state_script" "$pane_id")"
    verification="$(classify_verification "$payload" "$action_kind" "$before_json" "$after_json")"
    if [ "$verification" = "submitted" ] || [ "$verification" = "launch_blocker" ]; then
      break
    fi
  done
fi

if [ -z "${after_json:-}" ]; then
  after_json="$before_json"
fi

python3 - <<'PY' "$before_json" "$after_json" "$pane_id" "$action_kind" "$payload" "$verification"
import json, sys
before = json.loads(sys.argv[1])
after = json.loads(sys.argv[2])
event = {
  "pane_id": sys.argv[3],
  "session_name": before.get("session_name"),
  "action_kind": sys.argv[4],
  "payload": sys.argv[5],
  "before_state": before.get("state"),
  "after_state": after.get("state"),
  "verification": sys.argv[6],
  "before_last_line": before.get("last_line"),
  "after_last_line": after.get("last_line"),
}
print(json.dumps(event, indent=2))
PY

if [ -n "$trace_path" ]; then
  event_json="$(python3 - <<'PY' "$before_json" "$after_json" "$pane_id" "$action_kind" "$payload" "$verification"
import json, sys
before = json.loads(sys.argv[1])
after = json.loads(sys.argv[2])
print(json.dumps({
  "pane_id": sys.argv[3],
  "session_name": before.get("session_name"),
  "action_kind": sys.argv[4],
  "payload": sys.argv[5],
  "before_state": before.get("state"),
  "after_state": after.get("state"),
  "verification": sys.argv[6],
  "before_last_line": before.get("last_line"),
  "after_last_line": after.get("last_line"),
}))
PY
)"
  "$skill_dir/scripts/write-trace.py" "$trace_path" "$event_json"
fi
