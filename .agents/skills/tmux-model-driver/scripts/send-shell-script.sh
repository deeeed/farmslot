#!/bin/bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: send-shell-script.sh <pane-id> <repo-dir> [trace.jsonl]" >&2
  echo "Reads script body lines from stdin; writes .tmux-driver-launch.sh and executes it." >&2
  exit 1
fi

pane_id="$1"
repo_dir="$2"
trace_path="${3:-}"
skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
script_path="$repo_dir/.tmux-driver-launch.sh"

wait_for_shell_state() {
  local deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local state
    state="$(python3 - <<'PY' "$("$skill_dir/scripts/pane-state.sh" "$pane_id")"
import json, sys
print(json.loads(sys.argv[1])["state"])
PY
)"
    if [ "$state" = "shell" ]; then
      return 0
    fi
    sleep 0.5
  done
  echo "{\"error\":\"shell_not_ready\",\"pane_id\":\"$pane_id\"}" >&2
  return 1
}

wait_for_shell_state

{
  printf '%s\n' '#!/bin/bash'
  printf '%s\n' 'set -euo pipefail'
  printf 'cd %q\n' "$repo_dir"
  cat
  printf '\n'
} >"$script_path"
chmod +x "$script_path"

# Pane cwd is repo_dir (tmux new-session -c). Relative path avoids narrow-pane wrap
# truncating long /var/folders/.../.tmux-driver-launch.sh before Enter runs.
launch_cmd='bash .tmux-driver-launch.sh'
if [ -n "$trace_path" ]; then
  "$skill_dir/scripts/send-and-verify.sh" "$pane_id" shell "$trace_path" <<<"$launch_cmd"
else
  "$skill_dir/scripts/send-and-verify.sh" "$pane_id" shell <<<"$launch_cmd"
fi