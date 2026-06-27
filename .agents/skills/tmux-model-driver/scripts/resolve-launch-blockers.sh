#!/bin/bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: resolve-launch-blockers.sh <pane-id> <runner-id> [timeout-seconds]" >&2
  exit 1
fi

pane_id="$1"
runner_id="$2"
timeout_seconds="${3:-60}"
skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
deadline=$((SECONDS + timeout_seconds))
trust_answered=false
project_selected=false

while [ "$SECONDS" -lt "$deadline" ]; do
  state_json="$("$skill_dir/scripts/pane-state.sh" "$pane_id")"
  blocker_kind="$(python3 - <<'PY' "$state_json"
import json, sys
print(json.loads(sys.argv[1]).get("launch_blocker") or "")
PY
)"
  auto_action="$(python3 - <<'PY' "$state_json"
import json, sys
print(json.loads(sys.argv[1]).get("auto_action") or "")
PY
)"

  if [ "$auto_action" = "cursor-trust-workspace" ] && [ "$trust_answered" = false ]; then
    tmux send-keys -t "$pane_id" a
    trust_answered=true
    sleep 1.5
    continue
  fi

  if [ "$auto_action" = "grok-select-current-project" ] && [ "$project_selected" = false ]; then
    tmux send-keys -t "$pane_id" Enter
    project_selected=true
    sleep 1.5
    continue
  fi

  if [ -n "$blocker_kind" ]; then
    python3 - <<'PY' "$state_json" "$runner_id" "$blocker_kind" "$trust_answered" "$project_selected"
import json, sys
state = json.loads(sys.argv[1])
print(json.dumps({
  "pane_id": state.get("pane_id"),
  "runner_id": sys.argv[2],
  "resolved": False,
  "launch_blocker": sys.argv[3],
  "auto_action": state.get("auto_action"),
  "trust_answered": sys.argv[4] == "true",
  "project_selected": sys.argv[5] == "true",
  "state": state.get("state"),
  "phase": state.get("phase"),
}, indent=2))
PY
    exit 2
  fi

  python3 - <<'PY' "$state_json" "$runner_id" "$trust_answered" "$project_selected"
import json, sys
state = json.loads(sys.argv[1])
print(json.dumps({
  "pane_id": state.get("pane_id"),
  "runner_id": sys.argv[2],
  "resolved": True,
  "launch_blocker": None,
  "auto_action": None,
  "trust_answered": sys.argv[3] == "true",
  "project_selected": sys.argv[4] == "true",
  "state": state.get("state"),
  "phase": state.get("phase"),
}, indent=2))
PY
  exit 0
done

state_json="$("$skill_dir/scripts/pane-state.sh" "$pane_id")"
python3 - <<'PY' "$state_json" "$runner_id" "$trust_answered" "$project_selected"
import json, sys
state = json.loads(sys.argv[1])
print(json.dumps({
  "pane_id": state.get("pane_id"),
  "runner_id": sys.argv[2],
  "resolved": False,
  "launch_blocker": state.get("launch_blocker"),
  "auto_action": state.get("auto_action"),
  "trust_answered": sys.argv[3] == "true",
  "project_selected": sys.argv[4] == "true",
  "state": state.get("state"),
  "phase": state.get("phase"),
  "error": "timed out waiting for launch blockers to clear",
}, indent=2))
PY
exit 2