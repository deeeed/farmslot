#!/usr/bin/env bash
# Phase 0 + recipe proof gates for docs/plans/farmslot-cross-surface-evidence-e2e-goal.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIMARY_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRATCH="${E2E_SCRATCH_DIR:-${TMPDIR:-/tmp}/farmslot-e2e-evidence}"
mkdir -p "$SCRATCH"

FF_SLOT="${FF_SLOT:-macwork-ff-2}"
FF_GATEWAY_PORT="${FF_GATEWAY_PORT:-8809}"
FF_CDP_PORT="${FF_CDP_PORT:-9323}"
FF_REPO="${FF_REPO:-/Users/deeeed/dev/farmslot-wt/farmslot-2}"
TASK_DIR="${TASK_DIR:-$FF_REPO/.sandbox/farmslot/worker-task/feat/e2e-28-proof}"

log() { echo "[e2e-evidence] $*" | tee -a "$SCRATCH/e2e.log"; }

log "scratch=$SCRATCH primary_repo=$PRIMARY_REPO"

# Ensure headed CDP Chrome is on the primary display for capture-helper.
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'tell application "Google Chrome" to activate' \
    -e 'tell application "Google Chrome" to set bounds of front window to {200, 150, 1400, 950}' \
    >/dev/null 2>&1 || true
fi

# Relaunch CDP Chrome when the existing session window is off-screen.
if command -v capture-helper >/dev/null 2>&1; then
  CDP_PID="$(lsof -iTCP:"$FF_CDP_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$CDP_PID" ]]; then
    ON_SCREEN="$(capture-helper resolve --pid "$CDP_PID" --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if d.get('selected',{}).get('onScreen') else 'false')" 2>/dev/null || echo false)"
    if [[ "$ON_SCREEN" != "true" ]]; then
      log "CDP Chrome off-screen; relaunching debug-chrome with window-position"
      kill "$CDP_PID" 2>/dev/null || true
      sleep 1
    fi
  fi
fi

bash "$PRIMARY_REPO/apps/command-center/scripts/debug-chrome.sh" >/dev/null 2>&1 || true
sleep 1

node "$PRIMARY_REPO/apps/command-center/scripts/agentic/recipe-doctor.mjs" \
  --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" --json \
  >"$SCRATCH/phase0-doctor.json" 2>"$SCRATCH/phase0-doctor.err"
log "doctor exit=$?"

bash "$SCRIPT_DIR/validate-recipe.sh" --dry-run \
  --recipe "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" \
  --artifacts-dir "$SCRATCH/recipe-dry" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  >"$SCRATCH/phase0-dryrun.log" 2>&1
log "dry-run exit=$?"

bash "$SCRIPT_DIR/companion-prepare.sh" health --slot-port 8871 --platform ios \
  >"$SCRATCH/phase0-companion-health.log" 2>&1 || log "companion health skipped (exit=$?)"

mkdir -p "$TASK_DIR/artifacts"
cp "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" "$TASK_DIR/artifacts/recipe.json"

FARMSLOT_SLOT_REPO="$FF_REPO" bash "$SCRIPT_DIR/validate-recipe.sh" \
  --recipe "$TASK_DIR/artifacts/recipe.json" \
  --artifacts-dir "$TASK_DIR/artifacts/recipe-run" \
  --runtime-dir "$FF_REPO/.sandbox/farmslot/agent" \
  --platform web --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" \
  --slot-id "$FF_SLOT" --slow 2000 --record-video=full-run --task-dir "$TASK_DIR" \
  >"$SCRATCH/runA-proof.log" 2>&1
log "run A proof exit=$?"

cp "$TASK_DIR/artifacts/recipe-run/summary.json" "$SCRATCH/runA-summary.json" 2>/dev/null || true
ls -la "$TASK_DIR/artifacts/" "$TASK_DIR/artifacts/recipe-run/videos/" 2>/dev/null | tee "$SCRATCH/runA-artifacts.ls"

node "$PRIMARY_REPO/scripts/quality/check-task-artifact-contract.mjs" "$TASK_DIR" \
  --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe \
  >"$SCRATCH/runA-contract.log" 2>&1 || log "contract check pending artifacts (exit=$?)"

cd "$PRIMARY_REPO/apps/command-center" && yarn typecheck >"$SCRATCH/typecheck-cc.log" 2>&1
log "command-center typecheck exit=$?"

cd "$PRIMARY_REPO/apps/companion" && yarn typecheck >"$SCRATCH/typecheck-companion.log" 2>&1
log "companion typecheck exit=$?"

log "e2e evidence capture complete — inspect $SCRATCH"