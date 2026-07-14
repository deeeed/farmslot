#!/bin/bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: send-shell-script.sh <pane-id> <repo-dir> [trace.jsonl]" >&2
  echo "Reads script body lines from stdin; stages them outside the checkout and executes them." >&2
  exit 1
fi

pane_id="$1"
repo_dir="$2"
trace_path="${3:-}"
skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
stage_root="${TMUX_MODEL_DRIVER_STAGE_ROOT:-/tmp}"
stage_dir=""
dispatched=false

cleanup_undispatched() {
  if [ "$dispatched" != true ] && [ -n "$stage_dir" ]; then
    rm -rf -- "$stage_dir"
  fi
}
trap cleanup_undispatched EXIT

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

mkdir -p "$stage_root"
stage_dir="$(mktemp -d "$stage_root/tmux-model-driver.XXXXXX")"
chmod 700 "$stage_dir"

repo_dir="$(cd "$repo_dir" && pwd -P)"
stage_dir="$(cd "$stage_dir" && pwd -P)"
case "$stage_dir/" in
  "$repo_dir/"*)
    echo "refusing to stage a launch script inside the target checkout: $stage_dir" >&2
    exit 1
    ;;
esac

draft_path="$stage_dir/launch.sh"
{
  printf '%s\n' '#!/bin/bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'cleanup_staged_script() {'
  printf '%s\n' '  rm -f -- "$0"'
  printf '  rmdir -- %q 2>/dev/null || true\n' "$stage_dir"
  printf '%s\n' '}'
  printf '%s\n' 'trap cleanup_staged_script EXIT'
  printf '%s\n' '('
  printf '  cd %q\n' "$repo_dir"
  cat
  printf '%s\n' ')'
} >"$draft_path"

digest="$(shasum -a 256 "$draft_path" | awk '{print $1}')"
script_path="$stage_dir/launch-${digest:0:16}.sh"
mv "$draft_path" "$script_path"
chmod 600 "$script_path"

printf -v launch_cmd 'bash %q' "$script_path"
if [ -n "$trace_path" ]; then
  result="$("$skill_dir/scripts/send-and-verify.sh" "$pane_id" shell "$trace_path" <<<"$launch_cmd")"
else
  result="$("$skill_dir/scripts/send-and-verify.sh" "$pane_id" shell <<<"$launch_cmd")"
fi

verification="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["verification"])' <<<"$result")"
if [ "$verification" != "submitted" ]; then
  echo "$result" >&2
  exit 1
fi

dispatched=true
printf '%s\n' "$result"
