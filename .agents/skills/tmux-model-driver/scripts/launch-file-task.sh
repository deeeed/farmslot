#!/bin/bash
set -euo pipefail

if [ $# -lt 4 ] || [ $# -gt 7 ]; then
  echo "usage: launch-file-task.sh <pane-id> <runner> <model> <task-file> [trace.jsonl] [signal-file] [clean-room-skill-file]" >&2
  exit 1
fi

pane_id="$1"
runner="$2"
model="$3"
task_file="$4"
trace_path="${5:-}"
signal_file="${6:-}"
clean_room_skill_file="${7:-}"
task_dir="$(cd "$(dirname "$task_file")" && pwd)"
artifacts_dir="$task_dir/artifacts"
source_bundle_file="$task_dir/SOURCE-BUNDLE.md"
signal_file="${signal_file:-$task_dir/SIGNAL.json}"

skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
pane_state_script="${TMUX_MODEL_DRIVER_PANE_STATE_SCRIPT:-$skill_dir/scripts/pane-state.sh}"
send_script="${TMUX_MODEL_DRIVER_SEND_SCRIPT:-$skill_dir/scripts/send-and-verify.sh}"
state_json="$("$pane_state_script" "$pane_id")"
state="$(python3 - <<'PY' "$state_json"
import json, sys
print(json.loads(sys.argv[1])["state"])
PY
)"

if [ "$state" != "shell" ]; then
  echo "{\"error\":\"shell_required\",\"pane_id\":\"$pane_id\",\"state\":\"$state\"}"
  exit 2
fi

wrapper="$(python3 - <<'PY' "$task_file"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'^WRAPPER:\s*([^\n`]+)', text, flags=re.M)
print((m.group(1).strip() if m else "recipe-cook"))
PY
)"

instruction="Read \"$task_file\" and follow it top-to-bottom. This is file-first mode. Wrapper hint: \"$wrapper\". Update \"$task_file\" in place as you work. Mark [x] immediately after each completed step. Keep STATUS current. Write actual files to disk, not just chat output. Required write targets: \"$artifacts_dir/recipe.json\", \"$artifacts_dir/recipe-cook.json\" when supported, \"$artifacts_dir/recipe-cook-learning.json\", the rewritten \"$task_file\", and \"$signal_file\". Use \"$source_bundle_file\" as the source-material file. Do not stop before validation or explicit blocker. Terminal-state rule: write complete/success only when all required validations pass and no required proof target remains UNRESOLVED. If a required live/runtime dependency is unavailable, write blocked/partial with a concrete reason. If a required validation actually fails or proves a regression, write failed/failure with a concrete reason. When fully complete, write \"$signal_file\"."

printf -v model_q '%q' "$model"

case "$runner" in
  claude)
    if [ -n "$clean_room_skill_file" ]; then
      if [ ! -f "$clean_room_skill_file" ]; then
        echo "{\"error\":\"clean_room_skill_missing\",\"path\":\"$clean_room_skill_file\"}"
        exit 4
      fi
      clean_room_skill_dir="$(cd "$(dirname "$clean_room_skill_file")" && pwd -P)"
      clean_room_skill_file="$clean_room_skill_dir/$(basename "$clean_room_skill_file")"
      printf -v clean_room_skill_file_q '%q' "$clean_room_skill_file"
      instruction="$instruction Clean-room skill source: \"$clean_room_skill_file\". Resolve its relative scripts, references, and assets from \"$clean_room_skill_dir\"."
      printf -v instruction_q '%q' "$instruction"
      cmd="claude --safe-mode --append-system-prompt-file $clean_room_skill_file_q --disallowedTools Agent --dangerously-skip-permissions --model $model_q $instruction_q"
    else
      printf -v instruction_q '%q' "$instruction"
      cmd="claude --dangerously-skip-permissions --model $model_q $instruction_q"
    fi
    ;;
  codex)
    printf -v instruction_q '%q' "$instruction"
    cmd="codex --model $model_q $instruction_q"
    ;;
  *)
    echo "{\"error\":\"unsupported_runner\",\"runner\":\"$runner\"}"
    exit 3
    ;;
esac

printf '%s\n' "$cmd" | "$send_script" "$pane_id" shell "$trace_path"
