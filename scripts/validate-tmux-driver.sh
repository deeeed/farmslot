#!/usr/bin/env bash
# End-to-end validation for tmux-model-driver + runner-validation delegation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/.agents/skills/tmux-model-driver"
HOST="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"
FAIL=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAIL=1; }

echo "== tmux-model-driver validation on ${HOST} =="

echo "-- skill unit tests --"
bash "$SKILL/tests/pane-state.test.sh"
bash "$SKILL/tests/watch-file-task.test.sh"
bash "$SKILL/tests/launch-file-task.test.sh"
pass "skill unit tests"

echo "-- harness unit tests --"
node --test "$ROOT/scripts/runner-validation/run.test.mjs"
pass "harness unit tests"

echo "-- blocker parity fixtures --"
python3 - <<'PY' "$SKILL/scripts/pane-state.sh"
import json, subprocess, os, sys

pane_state = sys.argv[1]
fixtures = [
    ("grok", "project-directory", "grok-select-current-project", "Run Grok Build in a project directory?\n1 (○) x (current)\nEnter:submit"),
    ("cursor", "workspace-trust", "cursor-trust-workspace", "[a] trust this workspace\n[q] quit\nuse arrow keys to navigate"),
    ("cursor", None, None, "Run Grok Build in a project directory?\n(current)\nEnter:submit"),
    ("grok", None, None, "[a] trust this workspace\n[q] quit\nuse arrow keys to navigate"),
    ("cursor", "auth-required", None, "Authentication expired. Please run cursor-agent login to continue."),
]
for runner, exp_kind, exp_action, pane in fixtures:
    lines = [l for l in pane.split("\n") if l.strip()]
    env = {
        **os.environ,
        "TMUX_PANE_STATE_CURRENT_COMMAND": "",
        "TMUX_PANE_STATE_CURRENT_PATH": "",
        "TMUX_PANE_STATE_SESSION_NAME": "parity",
        "TMUX_PANE_STATE_PANE_TITLE": "",
        "TMUX_PANE_STATE_PANE_PID": "",
        "TMUX_PANE_STATE_TAIL_CAPTURE": pane,
        "TMUX_PANE_STATE_LAST_LINE": lines[-1] if lines else "",
    }
    out = subprocess.check_output(["bash", pane_state, "%0", runner], env=env, text=True)
    data = json.loads(out)
    if data.get("launch_blocker") != exp_kind or data.get("auto_action") != exp_action:
        raise SystemExit(f"parity mismatch runner={runner} got {data.get('launch_blocker')}/{data.get('auto_action')}")
print(f"parity fixtures: {len(fixtures)} ok")
PY
pass "blocker parity fixtures"

echo "-- live tmux: send-shell-script --"
SESSION="validate-send-$$"
REPO="$(mktemp -d "${TMPDIR:-/tmp}/validate-send-XXXXXX")"
git -C "$REPO" init -q >/dev/null 2>&1
tmux new-session -d -s "$SESSION" -c "$REPO"
PANE="$(tmux display-message -p -t "$SESSION" '#{pane_id}')"
printf '%s\n' "echo TMUX_DRIVER_SCRIPT_OK > '$REPO/marker.txt'" | bash "$SKILL/scripts/send-shell-script.sh" "$PANE" "$REPO" >/dev/null
for _ in $(seq 1 20); do
  if [ -f "$REPO/marker.txt" ]; then
    break
  fi
  sleep 0.5
done
if [ "$(cat "$REPO/marker.txt" 2>/dev/null || true)" = "TMUX_DRIVER_SCRIPT_OK" ]; then
  pass "send-shell-script writes and executes .tmux-driver-launch.sh"
else
  fail "send-shell-script marker missing"
  tmux capture-pane -pt "$PANE" -S -12 || true
fi
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -rf "$REPO"

echo "-- live tmux: resolve-launch-blockers idle shell --"
SESSION="validate-blocker-$$"
REPO="$(mktemp -d "${TMPDIR:-/tmp}/validate-blocker-XXXXXX")"
tmux new-session -d -s "$SESSION" -c "$REPO"
PANE="$(tmux display-message -p -t "$SESSION" '#{pane_id}')"
sleep 2
OUT="$(bash "$SKILL/scripts/resolve-launch-blockers.sh" "$PANE" grok 5)"
if python3 - <<'PY' "$OUT"
import json, sys
data = json.loads(sys.argv[1])
if not data.get("resolved"):
    raise SystemExit(data)
PY
then
  pass "resolve-launch-blockers on idle shell"
else
  fail "resolve-launch-blockers idle shell: $OUT"
fi
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -rf "$REPO"

if command -v grok >/dev/null 2>&1 || [ -x "$HOME/.grok/bin/grok" ]; then
  echo "-- live tmux: grok pane-smoke --"
  if node "$ROOT/scripts/runner-validation/run.mjs" --runner grok --scenario pane-smoke; then
    pass "grok pane-smoke"
  else
    fail "grok pane-smoke"
  fi
  echo "-- live tmux: grok interaction-smoke --"
  if node "$ROOT/scripts/runner-validation/run.mjs" --runner grok --scenario interaction-smoke; then
    pass "grok interaction-smoke"
  else
    fail "grok interaction-smoke"
  fi
else
  echo "SKIP: grok binary unavailable for live runner smokes"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "tmux-model-driver validation FAILED"
  exit 1
fi
echo "tmux-model-driver validation complete"