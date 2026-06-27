#!/usr/bin/env bash
# Live tmux E2E validation — primary ADR-032 / runner-driver proof (not unit tests).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/.agents/skills/tmux-model-driver"
HOST="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"
EVIDENCE_DIR="$ROOT/docs/operations/evidence"
FAIL=0

pass() { echo "E2E PASS: $*"; }
fail() { echo "E2E FAIL: $*"; FAIL=1; }
skip() { echo "E2E SKIP: $*"; }

mkdir -p "$EVIDENCE_DIR"

echo "== tmux runner E2E on ${HOST} =="

echo "-- skill: send-shell-script (live tmux) --"
SESSION="e2e-send-$$"
REPO="$(mktemp -d "${TMPDIR:-/tmp}/e2e-send-XXXXXX")"
git -C "$REPO" init -q >/dev/null 2>&1
tmux new-session -d -s "$SESSION" -c "$REPO"
PANE="$(tmux display-message -p -t "$SESSION" '#{pane_id}')"
printf '%s\n' "echo TMUX_DRIVER_SCRIPT_OK > '$REPO/marker.txt'" | bash "$SKILL/scripts/send-shell-script.sh" "$PANE" "$REPO" >/dev/null
for _ in $(seq 1 20); do
  [ -f "$REPO/marker.txt" ] && break
  sleep 0.5
done
if [ "$(cat "$REPO/marker.txt" 2>/dev/null || true)" = "TMUX_DRIVER_SCRIPT_OK" ]; then
  pass "send-shell-script"
else
  fail "send-shell-script (marker missing)"
  tmux capture-pane -pt "$PANE" -S -12 || true
fi
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -rf "$REPO"

echo "-- skill: resolve-launch-blockers idle shell --"
SESSION="e2e-blocker-$$"
REPO="$(mktemp -d "${TMPDIR:-/tmp}/e2e-blocker-XXXXXX")"
tmux new-session -d -s "$SESSION" -c "$REPO"
PANE="$(tmux display-message -p -t "$SESSION" '#{pane_id}')"
sleep 2
OUT="$(bash "$SKILL/scripts/resolve-launch-blockers.sh" "$PANE" grok 5)"
if python3 - <<'PY' "$OUT"
import json, sys
if not json.loads(sys.argv[1]).get("resolved"):
    raise SystemExit(1)
PY
then
  pass "resolve-launch-blockers idle shell"
else
  fail "resolve-launch-blockers idle shell: $OUT"
fi
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -rf "$REPO"

run_harness() {
  local runner="$1"
  local scenario="$2"
  # Codex hook-smoke needs a cool-down after Claude hook-smoke (Stop hook races).
  sleep 8
  if node "$ROOT/scripts/runner-validation/run.mjs" --runner "$runner" --scenario "$scenario"; then
    pass "${runner}/${scenario}"
  else
    fail "${runner}/${scenario}"
  fi
}

if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.npm-global/bin/claude" ]; then
  echo "-- harness: claude hook-smoke --"
  run_harness claude hook-smoke
else
  skip "claude hook-smoke (binary missing)"
fi

CODEX_BIN="$HOME/.npm-global/lib/node_modules/@openai/codex/bin/codex.js"
if [ -f "$CODEX_BIN" ]; then
  echo "-- harness: codex hook-smoke --"
  run_harness codex hook-smoke
else
  skip "codex hook-smoke (binary missing)"
fi

if command -v grok >/dev/null 2>&1 || [ -x "$HOME/.grok/bin/grok" ]; then
  echo "-- harness: grok pane-smoke --"
  run_harness grok pane-smoke
  echo "-- harness: grok interaction-smoke --"
  run_harness grok interaction-smoke
else
  skip "grok pane-smoke + interaction-smoke (binary missing)"
fi

CURSOR_BIN="$HOME/.local/bin/cursor-agent"
if command -v cursor-agent >/dev/null 2>&1 || [ -x "$CURSOR_BIN" ]; then
  echo "-- harness: cursor pane-smoke --"
  run_harness cursor pane-smoke
else
  skip "cursor pane-smoke (binary missing)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "tmux runner E2E FAILED on ${HOST}"
  exit 1
fi

echo "tmux runner E2E complete on ${HOST}"
echo "evidence: ${EVIDENCE_DIR}/runner-validate-${HOST}-*.json"