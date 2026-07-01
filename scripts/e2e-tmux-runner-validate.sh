#!/usr/bin/env bash
# Live tmux E2E validation — primary ADR-032 / runner-driver proof (not unit tests).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/.agents/skills/tmux-model-driver"
HOST="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"
EVIDENCE_DIR="$ROOT/docs/operations/evidence"
OPTIONAL_EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/runner-e2e-optional-XXXXXX")"
FAIL=0
HOOK_RAN=false
HOOK_PASSED=false
ATTRIBUTION_RAN=false
ATTRIBUTION_PASSED=false
TOKEN_USAGE_RAN=false
TOKEN_USAGE_PASSED=false
GROK_RAN=false
GROK_ATTRIBUTION_PASSED=false
GROK_TOKEN_PASSED=false

pass() { echo "E2E PASS: $*"; }
fail() { echo "E2E FAIL: $*"; FAIL=1; }
skip() { echo "E2E SKIP: $*"; }

runner_available() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 || [ -x "$HOME/.npm-global/bin/claude" ] ;;
    codex) [ -f "$HOME/.npm-global/lib/node_modules/@openai/codex/bin/codex.js" ] ;;
    grok) command -v grok >/dev/null 2>&1 || [ -x "$HOME/.grok/bin/grok" ] ;;
    cursor) command -v cursor-agent >/dev/null 2>&1 || [ -x "$HOME/.local/bin/cursor-agent" ] ;;
    *) return 1 ;;
  esac
}

mkdir -p "$EVIDENCE_DIR"
cleanup_optional_evidence() {
  rm -rf "$OPTIONAL_EVIDENCE_DIR"
}
trap cleanup_optional_evidence EXIT

echo "== tmux runner E2E on ${HOST} =="

echo "-- skill: send-shell-script (live tmux) --"
_send_shell_script_ok=false
for _attempt in 1 2; do
  SESSION="e2e-send-$$-${_attempt}"
  REPO="$(mktemp -d "${TMPDIR:-/tmp}/e2e-send-XXXXXX")"
  git -C "$REPO" init -q >/dev/null 2>&1
  # zsh/oh-my-zsh in default tmux sessions often ignores send-keys Enter; bash is reliable.
  tmux new-session -d -s "$SESSION" -c "$REPO" bash --noprofile --norc
  sleep 1
  PANE="$(tmux display-message -p -t "$SESSION" '#{pane_id}')"
  printf '%s\n' "echo TMUX_DRIVER_SCRIPT_OK > '$REPO/marker.txt'" | bash "$SKILL/scripts/send-shell-script.sh" "$PANE" "$REPO" >/dev/null
  sleep 1
  for _ in $(seq 1 30); do
    [ -f "$REPO/marker.txt" ] && break
    sleep 0.5
  done
  if [ "$(cat "$REPO/marker.txt" 2>/dev/null || true)" = "TMUX_DRIVER_SCRIPT_OK" ]; then
    _send_shell_script_ok=true
  elif [ "$_attempt" -eq 2 ]; then
    fail "send-shell-script (marker missing)"
    tmux capture-pane -pt "$PANE" -S -12 || true
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$REPO"
  $_send_shell_script_ok && break
  sleep 2
done
if $_send_shell_script_ok; then
  pass "send-shell-script"
fi

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
  local is_first="${3:-false}"
  local optional="${4:-false}"
  local out_dir="${5:-$EVIDENCE_DIR}"
  if [ "$is_first" != true ]; then
    sleep 15
  fi
  if node "$ROOT/scripts/runner-validation/run.mjs" --runner "$runner" --scenario "$scenario" --out-dir "$out_dir"; then
    pass "${runner}/${scenario}"
    return 0
  fi
  if [ "$optional" = true ]; then
    skip "${runner}/${scenario} (optional)"
    return 0
  fi
  fail "${runner}/${scenario}"
  return 1
}

FIRST_HARNESS=true
for runner in claude codex; do
  if runner_available "$runner"; then
    echo "-- harness: ${runner} hook-smoke --"
    HOOK_RAN=true
    if [ "$FIRST_HARNESS" = true ]; then
      if run_harness "$runner" hook-smoke true; then HOOK_PASSED=true; fi
      FIRST_HARNESS=false
    elif run_harness "$runner" hook-smoke false; then
      HOOK_PASSED=true
    fi
    echo "-- harness: ${runner} session-attribution-smoke --"
    ATTRIBUTION_RAN=true
    if run_harness "$runner" session-attribution-smoke false; then
      ATTRIBUTION_PASSED=true
    fi
    echo "-- harness: ${runner} token-usage-smoke --"
    TOKEN_USAGE_RAN=true
    if run_harness "$runner" token-usage-smoke false; then
      TOKEN_USAGE_PASSED=true
    fi
  else
    skip "${runner} hook-smoke (binary missing)"
  fi
done

if runner_available grok; then
  echo "-- harness: grok pane-smoke --"
  GROK_RAN=true
  if [ "$FIRST_HARNESS" = true ]; then
    run_harness grok pane-smoke true false "$OPTIONAL_EVIDENCE_DIR" || true
    FIRST_HARNESS=false
  else
    run_harness grok pane-smoke false false "$OPTIONAL_EVIDENCE_DIR" || true
  fi
  echo "-- harness: grok interaction-smoke --"
  run_harness grok interaction-smoke false false "$OPTIONAL_EVIDENCE_DIR" || true
  echo "-- harness: grok session-attribution-smoke --"
  if run_harness grok session-attribution-smoke false; then
    GROK_ATTRIBUTION_PASSED=true
  fi
  echo "-- harness: grok token-usage-smoke --"
  if run_harness grok token-usage-smoke false; then
    GROK_TOKEN_PASSED=true
  fi
else
  skip "grok pane-smoke + interaction-smoke (binary missing)"
fi

if runner_available cursor; then
  echo "-- harness: cursor pane-smoke (optional) --"
  if [ "$FIRST_HARNESS" = true ]; then
    run_harness cursor pane-smoke true true "$OPTIONAL_EVIDENCE_DIR"
    FIRST_HARNESS=false
  else
    run_harness cursor pane-smoke false true "$OPTIONAL_EVIDENCE_DIR"
  fi
else
  skip "cursor pane-smoke (binary missing)"
fi

if ! $HOOK_RAN; then
  fail "no hook runner binary available (need claude or codex for hook-smoke)"
elif ! $HOOK_PASSED; then
  fail "hook-smoke did not pass for any available event-driven runner"
fi

if $ATTRIBUTION_RAN && ! $ATTRIBUTION_PASSED; then
  fail "session-attribution-smoke did not pass for any available event-driven runner"
fi

if $TOKEN_USAGE_RAN && ! $TOKEN_USAGE_PASSED; then
  fail "token-usage-smoke did not pass for any available event-driven runner"
fi

if runner_available grok && ! $GROK_RAN; then
  fail "grok binary present but grok smokes did not run"
fi

if runner_available grok && ! $GROK_ATTRIBUTION_PASSED; then
  fail "grok session-attribution-smoke did not pass"
fi

if runner_available grok && ! $GROK_TOKEN_PASSED; then
  fail "grok token-usage-smoke did not pass"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "tmux runner E2E FAILED on ${HOST}"
  exit 1
fi

echo "tmux runner E2E complete on ${HOST}"
echo "committed evidence: ${EVIDENCE_DIR}/runner-validate-${HOST}-{claude,codex,grok}-{hook-smoke,session-attribution-smoke,token-usage-smoke}.json"
echo "optional evidence (local only): ${OPTIONAL_EVIDENCE_DIR}/runner-validate-${HOST}-*.json"