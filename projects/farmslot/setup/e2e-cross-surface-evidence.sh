#!/usr/bin/env bash
# Phase 0 + Runs A/B recipe proof + typecheck gates for
# docs/plans/farmslot-cross-surface-evidence-e2e-goal.md
#
# Single entry point: all scratch artifacts are written by this script.
# Set E2E_SCRATCH_DIR to the implementer scratch directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIMARY_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRATCH="${E2E_SCRATCH_DIR:-${TMPDIR:-/tmp}/farmslot-e2e-evidence}"
mkdir -p "$SCRATCH"

FF_SLOT="${FF_SLOT:-macwork-ff-2}"
FF_GATEWAY_PORT="${FF_GATEWAY_PORT:-8809}"
FF_CDP_PORT="${FF_CDP_PORT:-9323}"
FC_SLOT="${FC_SLOT:-macwork-fc-1}"
FC_METRO_PORT="${FC_METRO_PORT:-8871}"
FC_SIMULATOR="${FC_SIMULATOR:-fs-companion-1}"
FC_GATEWAY_PORT="${FC_GATEWAY_PORT:-8809}"

resolve_wt() {
  local name="$1"
  if [[ "$name" == /* ]]; then
    printf '%s' "$name"
    return 0
  fi
  local parent
  parent="$(cd "$PRIMARY_REPO/.." && pwd)"
  printf '%s/%s' "$parent" "$name"
}

CC_WT="${CC_WT:-}"
FC_WT="${FC_WT:-$(resolve_wt "farmslot-wt/farmslot-companion-1")}"
if [[ -z "$CC_WT" ]]; then
  CC_WT="$(resolve_wt "farmslot-wt/farmslot-2")"
fi
FF_REPO="${FF_REPO:-$CC_WT}"

TASK_DIR="${TASK_DIR:-}"
if [[ -z "$TASK_DIR" ]]; then
  TASK_DIR="$(find "$CC_WT/.sandbox/farmslot/worker-task" -type f -path '*/artifacts/recipe.json' 2>/dev/null \
    | xargs -I{} dirname {} 2>/dev/null | xargs -I{} dirname {} 2>/dev/null | sort -r | head -1 || true)"
fi

FC_TASK_DIR="${FC_TASK_DIR:-}"
if [[ -z "$FC_TASK_DIR" ]]; then
  FC_TASK_DIR="$(find "$FC_WT/.sandbox/farmslot/worker-task" -type f -path '*/artifacts/recipe.json' 2>/dev/null \
    | xargs -I{} dirname {} | xargs -I{} dirname {} | sort -r | head -1 || true)"
fi

log() { echo "[e2e-evidence] $*" | tee -a "$SCRATCH/e2e.log"; }

fail_step() {
  log "FAILED: $1 (exit=$2)"
  exit "$2"
}

capture_typecheck() {
  local repo="$1"
  local app="$2"
  local out_log="$3"
  if [[ ! -d "$repo/apps/$app" ]]; then
    echo "ERROR: missing $repo/apps/$app" >"$out_log"
    return 1
  fi
  {
    echo "=== typecheck $app ==="
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "repo: $repo"
    cd "$repo/apps/$app"
    echo "cwd: $(pwd)"
    echo "branch: $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
    echo "command: yarn typecheck"
    echo "--- stdout/stderr ---"
  } >"$out_log"
  set +e
  (cd "$repo/apps/$app" && yarn typecheck) >>"$out_log" 2>&1
  local ec=$?
  set -e
  {
    echo "--- end ---"
    echo "exit=$ec"
  } >>"$out_log"
  return "$ec"
}

stop_metro_listeners_on_port() {
  local port="$1"
  local pid cmd
  for pid in $(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null); do
    cmd="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
    if [[ "${cmd}" == *"expo"* || "${cmd}" == *"metro"* || "${cmd}" == *"@expo"* ]]; then
      kill "${pid}" 2>/dev/null || true
      sleep 1
      kill -9 "${pid}" 2>/dev/null || true
    fi
  done
}

ensure_cc_auth_env() {
  local auth_file="$CC_WT/.env.local-auth"
  local primary_auth="$PRIMARY_REPO/.env.local-auth"
  if [[ -f "$auth_file" || ! -f "$primary_auth" ]]; then
    return 0
  fi
  ln -sf "$primary_auth" "$auth_file"
  log "linked CC worktree .env.local-auth from primary repo"
}

prepare_cc_slot() {
  ensure_cc_auth_env
  log "preparing CC sandbox gateway :$FF_GATEWAY_PORT ui from $CC_WT"
  FARMSLOT_SLOT_REPO="$CC_WT" bash "$SCRIPT_DIR/sandbox-dev.sh" stop --gateway-port "$FF_GATEWAY_PORT" \
    >>"$SCRATCH/cc-sandbox-prep.log" 2>&1 || true
  sleep 2
  unset VITE_FARMSLOT_DEMO_BANNER
  FARMSLOT_SLOT_REPO="$CC_WT" bash "$SCRIPT_DIR/sandbox-dev.sh" start --gateway-port "$FF_GATEWAY_PORT" \
    >>"$SCRATCH/cc-sandbox-prep.log" 2>&1 \
    || fail_step "CC sandbox-dev start (see cc-sandbox-prep.log)" 1
  log "CC sandbox-dev ready on :$FF_GATEWAY_PORT"
}

ensure_cdp_chrome_visible() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'tell application "Google Chrome" to activate' \
      -e 'tell application "Google Chrome" to set bounds of front window to {200, 150, 1400, 950}' \
      >/dev/null 2>&1 || true
  fi
}

cdp_login_fleet() {
  local ui_hash="#fleet"
  local auth_state
  : >"$SCRATCH/cc-cdp-login.log"
  auth_state="$(FARMSLOT_ROOT="$CC_WT" FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
    node "$PRIMARY_REPO/apps/command-center/scripts/cdp.mjs" eval "$ui_hash" \
      "!document.querySelector('.auth-card')" 2>>"$SCRATCH/cc-cdp-login.log" || true)"
  if [[ "$auth_state" == "true" ]]; then
    log "CDP session already authenticated"
    return 0
  fi
  FARMSLOT_ROOT="$CC_WT" \
  FARMSLOT_GATEWAY="ws://127.0.0.1:${FF_GATEWAY_PORT}/ws" \
  FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
    node "$PRIMARY_REPO/apps/command-center/scripts/cdp.mjs" login "$ui_hash" \
    >>"$SCRATCH/cc-cdp-login.log" 2>&1 \
    || fail_step "CDP gateway login (see cc-cdp-login.log)" 1
  log "CDP gateway login ok"
}

wait_companion_bridge() {
  local port="$1"
  local tries="${2:-40}"
  while (( tries-- > 0 )); do
    if curl -sf -X POST "http://127.0.0.1:${port}/farmslot-recipe/command" \
        -H 'Content-Type: application/json' \
        -d '{"command":"status","nodeId":"e2e-bridge-wait","payload":{},"timeout_ms":8000}' \
        2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

prepare_companion_slot() {
  local app_dir="$FC_WT/apps/companion"
  local bundle_id="${COMPANION_BUNDLE_ID:-net.siteed.farmslot.development}"
  local metro_log="$SCRATCH/fc-metro-prep.log"
  log "preparing companion slot metro :$FC_METRO_PORT simulator $FC_SIMULATOR"
  pkill -INT -f "simctl io ${FC_SIMULATOR} recordVideo" 2>/dev/null || true

  if [[ "$(curl -s -m 4 "http://127.0.0.1:${FC_METRO_PORT}/status" 2>/dev/null || true)" == "packager-status:running" ]] \
      && wait_companion_bridge "$FC_METRO_PORT" 3; then
    log "companion metro :$FC_METRO_PORT already running with recipe bridge — reusing"
    return 0
  fi

  stop_metro_listeners_on_port "$FC_METRO_PORT"
  sleep 2
  : >"$metro_log"
  (
    cd "$app_dir"
    exec env APP_VARIANT=development METRO_PORT="$FC_METRO_PORT" \
      REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 \
      EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:${FC_GATEWAY_PORT}/ws" \
      EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1 \
      yarn expo start --dev-client --port "$FC_METRO_PORT"
  ) >>"$metro_log" 2>&1 &
  local tries=45
  while (( tries-- > 0 )); do
    [[ "$(curl -s -m 4 "http://127.0.0.1:${FC_METRO_PORT}/status" 2>/dev/null || true)" == "packager-status:running" ]] && break
    sleep 2
  done
  curl -sf -m 300 -o /dev/null "http://127.0.0.1:${FC_METRO_PORT}/node_modules/expo-router/entry.bundle?platform=ios&dev=true&hot=false" \
    || log "companion bundle warm failed — continuing (see $metro_log)"
  xcrun simctl boot "$FC_SIMULATOR" 2>/dev/null || true
  xcrun simctl terminate "$FC_SIMULATOR" "$bundle_id" >/dev/null 2>&1 || true
  sleep 1
  xcrun simctl launch "$FC_SIMULATOR" "$bundle_id" >/dev/null
  wait_companion_bridge "$FC_METRO_PORT" 60 \
    || fail_step "companion recipe bridge not ready (see $metro_log)" 1
  log "companion bridge ready on :$FC_METRO_PORT"
}

doctor_core_checks_ok() {
  local doctor_json="$1"
  [[ -f "$doctor_json" ]] || return 1
  python3 - <<'PY' "$doctor_json"
import json, sys
doc = json.load(open(sys.argv[1]))
checks = doc.get("checks", [])
if not checks:
    sys.exit(1)
allowed_fail = {"capture_helper.doctor", "capture_helper.window.on_screen"}
for check in checks:
    if check.get("status") != "pass" and check.get("id") not in allowed_fail:
        sys.exit(1)
sys.exit(0)
PY
}

capture_helper_screen_recording_ok() {
  local doctor_json="$1"
  [[ -f "$doctor_json" ]] || return 1
  python3 - <<'PY' "$doctor_json"
import json, sys
doc = json.load(open(sys.argv[1]))
for check in doc.get("checks", []):
    if check.get("id") == "window_enumeration":
        sys.exit(0 if check.get("ok") else 1)
sys.exit(1)
PY
}

verify_task_mp4() {
  local mp4="$1"
  local gate_log="$2"
  {
    echo "=== task mp4 gate ==="
    echo "path: $mp4"
    if [[ ! -f "$mp4" ]]; then
      echo "missing: true"
      echo "gate: FAIL"
      return 1
    fi
    echo "bytes: $(wc -c <"$mp4" | tr -d ' ')"
    if strings "$mp4" | grep -q moov; then
      echo "moov: present"
      echo "gate: PASS"
      return 0
    fi
    echo "moov: absent"
    echo "gate: FAIL"
    return 1
  } >"$gate_log" 2>&1
}

run_recipe_proof() {
  local label="$1"
  local slot_repo="$2"
  local recipe_path="$3"
  local artifacts_dir="$4"
  local task_dir="$5"
  local platform="$6"
  local proof_log="$7"
  shift 7
  local video_args=()
  # RECORD_VIDEO_MODE unset => default full-run; empty string => omit --record-video.
  if [[ "${RECORD_VIDEO_MODE-__unset__}" == "__unset__" ]]; then
    video_args=(--record-video=full-run)
  elif [[ -n "$RECORD_VIDEO_MODE" ]]; then
    video_args=(--record-video="$RECORD_VIDEO_MODE")
  fi
  # Remaining args forwarded to validate-recipe.sh
  FARMSLOT_SLOT_REPO="$slot_repo" EXPO_PUBLIC_GATEWAY_URL="${EXPO_PUBLIC_GATEWAY_URL:-}" \
    bash "$SCRIPT_DIR/validate-recipe.sh" \
      --recipe "$recipe_path" \
      --artifacts-dir "$artifacts_dir" \
      --runtime-dir "$slot_repo/.sandbox/farmslot/agent" \
      --platform "$platform" \
      "$@" \
      --slow 2000 "${video_args[@]}" --task-dir "$task_dir" \
      >"$proof_log" 2>&1
}

# Pin native capture-helper (same resolution as validate-recipe.sh).
resolve_capture_helper_bin() {
  local candidate
  for candidate in \
    "${HOME}/.npm-global/lib/node_modules/@siteed/capture-helper/native/capture-helper" \
    "${CAPTURE_HELPER_PATH:-}" \
    "${SITEED_CAPTURE_HELPER_BIN:-}"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}
if helper_bin="$(resolve_capture_helper_bin)"; then
  export CAPTURE_HELPER_PATH="${helper_bin}"
  export SITEED_CAPTURE_HELPER_BIN="${helper_bin}"
fi

log "scratch=$SCRATCH primary_repo=$PRIMARY_REPO cc_wt=$CC_WT fc_wt=$FC_WT"

# ── Phase 0 ─────────────────────────────────────────────────────────────

if command -v osascript >/dev/null 2>&1; then
  osascript -e 'tell application "Google Chrome" to activate' \
    -e 'tell application "Google Chrome" to set bounds of front window to {200, 150, 1400, 950}' \
    >/dev/null 2>&1 || true
fi

VITE_PORT="$(python3 - <<'PY' "$CC_WT"
import pathlib, sys
repo = sys.argv[1]
ports = pathlib.Path(repo) / ".env.ports"
ui = "5174"
if ports.is_file():
    for line in ports.read_text().splitlines():
        if line.startswith("VITE_PORT="):
            ui = line.split("=", 1)[1].strip()
            break
print(ui)
PY
)"
prepare_cc_slot

export FARMSLOT_UI_URL="http://localhost:${VITE_PORT}/"
export FARMSLOT_CDP_PORT="$FF_CDP_PORT"
CDP_PID="$(lsof -iTCP:"$FF_CDP_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [[ -z "$CDP_PID" ]]; then
  log "launching CDP Chrome for slot UI ${FARMSLOT_UI_URL} cdp :${FF_CDP_PORT}"
  FARMSLOT_UI_URL="$FARMSLOT_UI_URL" FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
    bash "$PRIMARY_REPO/apps/command-center/scripts/debug-chrome.sh" >>"$SCRATCH/e2e.log" 2>&1 \
    || fail_step "debug-chrome" $?
else
  log "reusing CDP session on :${FF_CDP_PORT}"
fi
sleep 2
ensure_cdp_chrome_visible
FARMSLOT_UI_URL="$FARMSLOT_UI_URL" FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
  bash "$PRIMARY_REPO/apps/command-center/scripts/debug-chrome.sh" >>"$SCRATCH/e2e.log" 2>&1 \
  || fail_step "debug-chrome navigate" $?
sleep 2
ensure_cdp_chrome_visible
cdp_login_fleet
if [[ -n "${CAPTURE_HELPER_PATH:-}" ]]; then
  CDP_PID="$(lsof -iTCP:"$FF_CDP_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$CDP_PID" ]]; then
    "$CAPTURE_HELPER_PATH" snapshot --pid "$CDP_PID" -o "$SCRATCH/cdp-preflight.png" >>"$SCRATCH/e2e.log" 2>&1 \
      && log "capture-helper preflight snapshot ok" \
      || log "capture-helper preflight snapshot failed — video may be blocked by ScreenCaptureKit"
  fi
fi

if helper_bin="$(resolve_capture_helper_bin)"; then
  "$helper_bin" doctor --json >"$SCRATCH/phase0-capture-helper-doctor.json" 2>&1 || true
  if capture_helper_screen_recording_ok "$SCRATCH/phase0-capture-helper-doctor.json"; then
    CC_WEB_RECORD_VIDEO="full-run"
    log "capture-helper screen recording ok — Run A will record MP4"
  else
    CC_WEB_RECORD_VIDEO=""
    log "capture-helper screen recording denied — Run A recipe without live video (verify task after.mp4)"
  fi
else
  CC_WEB_RECORD_VIDEO=""
  log "capture-helper binary missing — Run A recipe without live video"
fi

set +e
node "$PRIMARY_REPO/apps/command-center/scripts/agentic/recipe-doctor.mjs" \
  --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" --json \
  >"$SCRATCH/phase0-doctor.json" 2>"$SCRATCH/phase0-doctor.err"
doctor_ec=$?
set -e
if [[ "$doctor_ec" -ne 0 ]]; then
  if [[ -z "$CC_WEB_RECORD_VIDEO" ]] && doctor_core_checks_ok "$SCRATCH/phase0-doctor.json"; then
    log "recipe-doctor capture-helper checks failed (screen recording denied) — core checks pass"
  else
    fail_step "recipe-doctor" "$doctor_ec"
  fi
else
  log "doctor exit=0"
fi

bash "$SCRIPT_DIR/validate-recipe.sh" --dry-run \
  --recipe "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" \
  --artifacts-dir "$SCRATCH/recipe-dry" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  >"$SCRATCH/phase0-dryrun.log" 2>&1 \
  || fail_step "validate-recipe dry-run" $?
log "dry-run exit=0"

{
  echo "=== companion-prepare health ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "slot-port: $FC_METRO_PORT platform: ios"
  echo "metro_listening: $(lsof -nP -iTCP:"$FC_METRO_PORT" -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ')"
  curl -sf "http://127.0.0.1:${FC_METRO_PORT}/status" 2>&1 && echo "" || echo "metro_status: unreachable"
  bash "$SCRIPT_DIR/companion-prepare.sh" health --slot-port "$FC_METRO_PORT" --platform ios
  echo "health_exit=$?"
} >"$SCRATCH/phase0-companion-health.log" 2>&1 \
  || fail_step "companion-prepare health" $?
log "companion health exit=0"

# Dry-run consistency (verification plan step 8)
bash "$SCRIPT_DIR/validate-recipe.sh" --dry-run \
  --recipe "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" \
  --artifacts-dir "$SCRATCH/recipe-dry-rerun1" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  >"$SCRATCH/phase0-dryrun-rerun1.log" 2>&1 \
  || fail_step "dry-run rerun1" $?
bash "$SCRIPT_DIR/validate-recipe.sh" --dry-run \
  --recipe "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" \
  --artifacts-dir "$SCRATCH/recipe-dry-rerun2" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  >"$SCRATCH/phase0-dryrun-rerun2.log" 2>&1 \
  || fail_step "dry-run rerun2" $?

# ── Run A (Command Center) ──────────────────────────────────────────────

if [[ -z "$TASK_DIR" || ! -d "$TASK_DIR" ]]; then
  fail_step "TASK_DIR missing under CC worktree (set TASK_DIR)" 1
fi
if [[ ! -f "$TASK_DIR/artifacts/recipe.json" ]]; then
  mkdir -p "$TASK_DIR/artifacts"
  cp "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" "$TASK_DIR/artifacts/recipe.json"
fi

ensure_cdp_chrome_visible
RECORD_VIDEO_MODE="$CC_WEB_RECORD_VIDEO" \
  run_recipe_proof "run A" "$CC_WT" "$TASK_DIR/artifacts/recipe.json" \
  "$TASK_DIR/artifacts/recipe-run" "$TASK_DIR" web "$SCRATCH/runA-proof.log" \
  --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  || fail_step "run A proof validate-recipe" $?
if [[ -z "$CC_WEB_RECORD_VIDEO" ]]; then
  verify_task_mp4 "$TASK_DIR/artifacts/after.mp4" "$SCRATCH/runA-video-gate.log" \
    || fail_step "run A after.mp4 gate (screen recording denied; see phase0-capture-helper-doctor.json)" 1
  log "run A proof exit=0 (recipe nodes; task after.mp4 gate pass)"
else
  log "run A proof exit=0 (recipe + live MP4)"
fi

cp "$TASK_DIR/artifacts/recipe-run/summary.json" "$SCRATCH/runA-summary.json" 2>/dev/null || true
{
  echo "=== Run A artifacts ==="
  ls -la "$TASK_DIR/artifacts/after.mp4" "$TASK_DIR/artifacts/"*.png 2>&1 || true
  echo ""
  cat "$TASK_DIR/artifacts/recipe-run/summary.json" 2>/dev/null || true
} >"$SCRATCH/runA-artifacts.log" 2>&1

node "$PRIMARY_REPO/scripts/quality/check-task-artifact-contract.mjs" "$TASK_DIR" \
  --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe \
  >"$SCRATCH/runA-contract.log" 2>&1 \
  || fail_step "run A task artifact contract" $?
log "run A contract exit=0"

# ── Run B (Companion) ───────────────────────────────────────────────────

if [[ -z "$FC_TASK_DIR" || ! -f "$FC_TASK_DIR/artifacts/recipe.json" ]]; then
  fail_step "FC_TASK_DIR missing or has no artifacts/recipe.json (set FC_TASK_DIR)" 1
fi

EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:${FC_GATEWAY_PORT}/ws"
export EXPO_PUBLIC_GATEWAY_URL

prepare_companion_slot

run_recipe_proof "run B" "$FC_WT" "$FC_TASK_DIR/artifacts/recipe.json" \
  "$FC_TASK_DIR/artifacts/recipe-run-ui" "$FC_TASK_DIR" ios "$SCRATCH/runB-ui-recipe-proof.log" \
  --metro-port "$FC_METRO_PORT" --simulator "$FC_SIMULATOR" \
  --gateway-port "$FC_GATEWAY_PORT" --slot-id "$FC_SLOT" \
  || fail_step "run B ui recipe proof" $?
log "run B ui recipe proof exit=0"

{
  echo "=== Run B artifacts ==="
  ls -la "$FC_TASK_DIR/artifacts/after.mp4" "$FC_TASK_DIR/artifacts/"*.png 2>&1 || true
  echo ""
  cat "$FC_TASK_DIR/artifacts/recipe-run-ui/summary.json" 2>/dev/null || true
  echo ""
  if [[ -f "$FC_TASK_DIR/artifacts/after.mp4" ]]; then
    echo "moov:"
    strings "$FC_TASK_DIR/artifacts/after.mp4" | grep -o moov | head -1 || true
  fi
} >"$SCRATCH/runB-artifacts.log" 2>&1

node "$PRIMARY_REPO/scripts/quality/check-task-artifact-contract.mjs" "$FC_TASK_DIR" \
  --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe \
  >"$SCRATCH/runB-contract.log" 2>&1 \
  || fail_step "run B task artifact contract" $?
log "run B contract exit=0"

# ── Typechecks on feat worktrees (verification plan step 5) ─────────────

capture_typecheck "$CC_WT" command-center "$SCRATCH/typecheck-cc-runA.log" \
  || fail_step "command-center typecheck (cc worktree)" $?
log "command-center typecheck exit=0 (branch in typecheck-cc-runA.log)"

capture_typecheck "$FC_WT" companion "$SCRATCH/typecheck-companion-runB.log" \
  || fail_step "companion typecheck (fc worktree)" $?
log "companion typecheck exit=0 (branch in typecheck-companion-runB.log)"

# ── Git state snapshot (verification plan step 9) ───────────────────────

{
  echo "=== primary repo (tooling PR) ==="
  cd "$PRIMARY_REPO"
  echo "cwd: $(pwd)"
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  git log --oneline -5
  git status --short
  echo ""
  echo "=== CC worktree ==="
  echo "path: $CC_WT branch: $(git -C "$CC_WT" rev-parse --abbrev-ref HEAD)"
  echo ""
  echo "=== FC worktree ==="
  echo "path: $FC_WT branch: $(git -C "$FC_WT" rev-parse --abbrev-ref HEAD)"
} >"$SCRATCH/git-state.log" 2>&1

log "e2e evidence capture complete — inspect $SCRATCH"