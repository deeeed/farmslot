#!/bin/bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: watch-file-task.sh <task-dir> [--state-file path] [--trace path] [--grace-sec n] [--window-sec n]" >&2
  exit 1
fi

task_dir="$1"
shift

state_file=""
trace_path=""
grace_sec=180
window_sec=120

while [ $# -gt 0 ]; do
  case "$1" in
    --state-file) state_file="$2"; shift 2 ;;
    --trace) trace_path="$2"; shift 2 ;;
    --grace-sec) grace_sec="$2"; shift 2 ;;
    --window-sec) window_sec="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$state_file" ]; then
  state_file="$task_dir/.watch-state.json"
fi

skill_dir="$(cd "$(dirname "$0")/.." && pwd)"
now_epoch="${WATCH_NOW_EPOCH:-$(date +%s)}"

snapshot_json="$(
python3 - <<'PY' "$task_dir" "$now_epoch"
import json, os, re, sys
from pathlib import Path

task_dir = Path(sys.argv[1])
now_epoch = int(sys.argv[2])
task_path = task_dir / "TASK.md"
artifacts_dir = task_dir / "artifacts"
recipe_path = artifacts_dir / "recipe.json"
learning_path = artifacts_dir / "recipe-cook-learning.json"
signal_path = task_dir / "SIGNAL.json"

def mtime(path: Path):
    return int(path.stat().st_mtime) if path.exists() else None

checkbox_done = 0
status = None
if task_path.exists():
    text = task_path.read_text(encoding="utf-8")
    checkbox_done = len(re.findall(r"^- \[(?:x|X)\]", text, flags=re.M))
    m = re.search(r"STATUS:\s*([^\n]+)", text)
    if m:
        status = m.group(1).strip()

signal = None
if signal_path.exists():
    try:
        signal = json.loads(signal_path.read_text(encoding="utf-8"))
    except Exception:
        signal = {"status": "invalid", "reason": "unparseable_signal"}

print(json.dumps({
    "task_dir": str(task_dir),
    "now_epoch": now_epoch,
    "task_exists": task_path.exists(),
    "task_mtime": mtime(task_path),
    "checkbox_done": checkbox_done,
    "task_status": status,
    "recipe_exists": recipe_path.exists(),
    "recipe_mtime": mtime(recipe_path),
    "learning_exists": learning_path.exists(),
    "learning_mtime": mtime(learning_path),
    "signal_exists": signal_path.exists(),
    "signal": signal,
}))
PY
)"

decision_json="$(
python3 - <<'PY' "$snapshot_json" "$state_file" "$grace_sec" "$window_sec"
import json, os, sys
from pathlib import Path

snapshot = json.loads(sys.argv[1])
state_file = Path(sys.argv[2])
grace_sec = int(sys.argv[3])
window_sec = int(sys.argv[4])

previous = None
if state_file.exists():
    previous = json.loads(state_file.read_text(encoding="utf-8"))

now = snapshot["now_epoch"]
terminal_signal = snapshot.get("signal") or {}
signal_status = terminal_signal.get("status")
if signal_status in {"complete", "done", "failed", "blocked"}:
    result = {
        "decision": "terminal",
        "reason": f"signal:{signal_status}",
        "snapshot": snapshot,
    }
    print(json.dumps(result))
    sys.exit(0)

def progress_changed(prev, current):
    keys = ["task_mtime", "checkbox_done", "task_status", "recipe_mtime", "learning_mtime"]
    return any(prev.get(k) != current.get(k) for k in keys)

if previous is None:
    baseline = {
        "started_at": now,
        "last_progress_at": now,
        "snapshot": snapshot,
    }
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "decision": "grace",
        "reason": "first_observation",
        "snapshot": snapshot,
    }))
    sys.exit(0)

started_at = previous.get("started_at", now)
last_progress_at = previous.get("last_progress_at", started_at)
prev_snapshot = previous.get("snapshot", {})

if progress_changed(prev_snapshot, snapshot):
    updated = {
        "started_at": started_at,
        "last_progress_at": now,
        "snapshot": snapshot,
    }
    state_file.write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "decision": "healthy",
        "reason": "file_progress",
        "snapshot": snapshot,
    }))
    sys.exit(0)

if now - started_at < grace_sec:
    print(json.dumps({
        "decision": "grace",
        "reason": "initial_grace_window",
        "snapshot": snapshot,
    }))
    sys.exit(0)

if now - last_progress_at >= window_sec:
    print(json.dumps({
        "decision": "false_progress",
        "reason": f"no_file_progress_for_{window_sec}s",
        "snapshot": snapshot,
    }))
    sys.exit(0)

print(json.dumps({
    "decision": "waiting",
    "reason": "within_progress_window",
    "snapshot": snapshot,
}))
PY
)"

printf '%s\n' "$decision_json"

if [ -n "$trace_path" ]; then
  "$skill_dir/scripts/write-trace.py" "$trace_path" "$decision_json"
fi
