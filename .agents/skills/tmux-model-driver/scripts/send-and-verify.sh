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
before_json="$("$skill_dir/scripts/pane-state.sh" "$pane_id")"
before_state="$(python3 - <<'PY' "$before_json"
import json, sys
print(json.loads(sys.argv[1])["state"])
PY
)"

submit_key_for_action() {
  case "$1" in
    cursor) echo "C-m" ;;
    *) echo "Enter" ;;
  esac
}

if [ "$action_kind" = "shell" ] && [ "$before_state" != "shell" ]; then
  verification="shell_launch_blocked"
else
  submit_key="$(submit_key_for_action "$action_kind")"
  tmux send-keys -t "$pane_id" -l "$payload"
  tmux send-keys -t "$pane_id" "$submit_key"
  sleep 1
  after_json="$("$skill_dir/scripts/pane-state.sh" "$pane_id")"
  verification="$(python3 - <<'PY' "$payload" "$after_json"
import json, sys
payload = sys.argv[1].strip()
after = json.loads(sys.argv[2])
last_line = (after.get("last_line") or "").strip()
tail = after.get("tail") or ""
if "ctrl+g to edit in Nvim" in last_line:
    print("input_buffered")
elif payload and payload in last_line:
    print("pending_input")
elif payload and payload in tail and "ctrl+g to edit in Nvim" in tail:
    print("input_buffered")
elif payload and payload in tail and after.get("state") in {"claude", "codex", "grok", "cursor"} and last_line == "❯":
    print("likely_pending_input")
elif after.get("phase") == "launch-blocker":
    print("launch_blocker")
else:
    print("submitted")
PY
)"
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
