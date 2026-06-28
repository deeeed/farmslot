#!/usr/bin/env bash
# Phase 0 + Runs A/B recipe proof + typecheck gates for
# docs/plans/farmslot-cross-surface-evidence-e2e-goal.md
#
# Single entry point: all scratch artifacts are written by this script.
# Set E2E_SCRATCH_DIR to the implementer scratch directory.
# Set E2E_PHASE0_ONLY=1 to stop after Phase 0 (doctor, dry-run, companion health).
# Set E2E_TRACK1=1 to dispatch autonomous Runs A/B and assert gate invariants (no approve).
# Optional overrides (zero-nudge defaults):
#   CC_BRANCH=feat/28-add-demo-red-banner  FC_BRANCH=feat/29-add-companion-demo-banner
#   TASK_DIR / FC_TASK_DIR — auto-resolved when unset (FC prefers real ui.* ios recipes)
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
CC_BRANCH="${CC_BRANCH:-feat/28-add-demo-red-banner}"
FC_BRANCH="${FC_BRANCH:-feat/29-add-companion-demo-banner}"
CC_TICKET="${CC_TICKET:-deeeed/farmslot#28}"
FC_TICKET="${FC_TICKET:-deeeed/farmslot#29}"
TRACK1_POLL_BUDGET_SEC="${TRACK1_POLL_BUDGET_SEC:-7200}"

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
  TASK_DIR="$(find "$CC_WT/.sandbox/farmslot-farm/worker-task" -type f -path '*/artifacts/recipe.json' 2>/dev/null \
    | xargs -I{} dirname {} 2>/dev/null | xargs -I{} dirname {} 2>/dev/null | sort -r | head -1 || true)"
fi

FC_TASK_DIR="${FC_TASK_DIR:-}"

resolve_fc_task_dir() {
  local recipe_path best="" best_score=0 score dir
  while IFS= read -r recipe_path; do
    [[ -f "$recipe_path" ]] || continue
    dir="$(dirname "$(dirname "$recipe_path")")"
    score=0
    if grep -q '"action": "ui\.' "$recipe_path" 2>/dev/null; then score=$((score + 10)); fi
    if grep -qi 'MOBILE OPERATOR' "$recipe_path" 2>/dev/null; then score=$((score + 5)); fi
    if grep -q '"platform": "ios' "$recipe_path" 2>/dev/null; then score=$((score + 3)); fi
    if grep -q 'sanity-cmd' "$recipe_path" 2>/dev/null; then score=$((score - 20)); fi
    if (( score > best_score )); then
      best_score=$score
      best="$dir"
    fi
  done < <(find "$FC_WT/.sandbox" -type f -path '*/artifacts/recipe.json' 2>/dev/null || true)
  printf '%s' "$best"
}

if [[ -z "$FC_TASK_DIR" ]]; then
  FC_TASK_DIR="$(resolve_fc_task_dir)"
fi

log() { echo "[e2e-evidence] $*" | tee -a "$SCRATCH/e2e.log"; }

ensure_feature_branch() {
  local wt="$1"
  local branch="$2"
  local label="$3"
  local current=""
  current="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$current" == "$branch" ]]; then
    return 0
  fi
  log "checking out $label worktree $branch (was ${current:-unknown})"
  git -C "$wt" fetch origin "$branch" >>"$SCRATCH/e2e.log" 2>&1 \
    || fail_step "$label fetch origin/$branch" 1
  if git -C "$wt" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$wt" checkout "$branch" >>"$SCRATCH/e2e.log" 2>&1 \
      || fail_step "$label checkout $branch" 1
  else
    git -C "$wt" checkout -B "$branch" "origin/$branch" >>"$SCRATCH/e2e.log" 2>&1 \
      || fail_step "$label checkout -B $branch origin/$branch" 1
  fi
}

stop_stale_sim_recording() {
  pkill -INT -f "xcrun simctl io.*recordVideo" 2>/dev/null || true
  pkill -INT -f "simctl io ${FC_SIMULATOR} recordVideo" 2>/dev/null || true
  pkill -INT -f "SimRender.*recordVideo" 2>/dev/null || true
  sleep 2
  pkill -KILL -f "xcrun simctl io.*recordVideo" 2>/dev/null || true
  pkill -KILL -f "SimRender.*recipe-run" 2>/dev/null || true
}

fail_step() {
  log "FAILED: $1 (exit=$2)"
  exit "$2"
}

PHASE0_BUDGET_SEC="${PHASE0_BUDGET_SEC:-120}"
PHASE0_STARTED_SEC=$SECONDS

phase0_budget_check() {
  local label="${1:-step}"
  if (( SECONDS - PHASE0_STARTED_SEC > PHASE0_BUDGET_SEC )); then
    fail_step "Phase 0 exceeded ${PHASE0_BUDGET_SEC}s budget at ${label}" 124
  fi
}

resolve_chrome_cdp_listener_pid() {
  local port="$1"
  local pid comm attempt
  for attempt in 1 2 3 4 5; do
    pid="$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ -n "$pid" ]]; then
      comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
      if [[ "$comm" == *chrome* || "$comm" == *chromium* ]]; then
        printf '%s' "$pid"
        return 0
      fi
    fi
    sleep 0.4
  done
  return 1
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

navigate_cdp_fleet() {
  local fleet_url="${FARMSLOT_UI_URL%\#*}#fleet"
  local fleet_base="${FARMSLOT_UI_URL%\#*}"
  local fleet_url_js fleet_base_js
  fleet_url_js="$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$fleet_url")"
  fleet_base_js="$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$fleet_base")"
  FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
    node "$PRIMARY_REPO/apps/command-center/scripts/cdp.mjs" eval "-" \
      "const t=${fleet_url_js}; const b=${fleet_base_js}; if (!location.href.startsWith(b) || location.hash !== '#fleet') { window.location.href=t; await new Promise((r) => setTimeout(r, 2000)); } true" \
      >>"$SCRATCH/e2e.log" 2>>"$SCRATCH/e2e.log" \
      || fail_step "CDP navigate to fleet (${fleet_url})" 1
}

cdp_login_fleet() {
  local ui_hash="#fleet"
  local auth_state
  local login_timeout="${CDP_LOGIN_TIMEOUT_SEC:-120}"
  : >"$SCRATCH/cc-cdp-login.log"
  auth_state="$(FARMSLOT_ROOT="$CC_WT" FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
    node "$PRIMARY_REPO/apps/command-center/scripts/cdp.mjs" eval "$ui_hash" \
      "!document.querySelector('.auth-card')" 2>>"$SCRATCH/cc-cdp-login.log" || true)"
  if [[ "$auth_state" == "true" ]]; then
    log "CDP session already authenticated"
    return 0
  fi
  log "CDP login starting (timeout ${login_timeout}s)"
  if ! python3 - <<PY "$login_timeout" "$CC_WT" "$FF_CDP_PORT" "$FF_GATEWAY_PORT" "$ui_hash" "$PRIMARY_REPO" "$SCRATCH/cc-cdp-login.log"
import subprocess, sys
timeout = int(sys.argv[1])
cc_wt, cdp_port, gw_port, ui_hash, repo, log_path = sys.argv[2:8]
cmd = [
    "node", f"{repo}/apps/command-center/scripts/cdp.mjs", "login", ui_hash,
]
env = {
    **__import__("os").environ,
    "FARMSLOT_ROOT": cc_wt,
    "FARMSLOT_GATEWAY": f"ws://127.0.0.1:{gw_port}/ws",
    "FARMSLOT_CDP_PORT": cdp_port,
}
try:
    with open(log_path, "a", encoding="utf-8") as logf:
        subprocess.run(cmd, env=env, stdout=logf, stderr=subprocess.STDOUT, timeout=timeout, check=True)
except subprocess.TimeoutExpired:
    print(f"CDP login exceeded {timeout}s", file=sys.stderr)
    sys.exit(124)
except subprocess.CalledProcessError as exc:
    sys.exit(exc.returncode or 1)
PY
  then
    fail_step "CDP gateway login (see cc-cdp-login.log)" 1
  fi
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
  stop_stale_sim_recording

  if [[ "$(curl -s -m 4 "http://127.0.0.1:${FC_METRO_PORT}/status" 2>/dev/null || true)" == "packager-status:running" ]] \
      && wait_companion_bridge "$FC_METRO_PORT" 3; then
    log "companion metro :$FC_METRO_PORT already running with recipe bridge — reusing (relaunch sim)"
    xcrun simctl boot "$FC_SIMULATOR" 2>/dev/null || true
    xcrun simctl terminate "$FC_SIMULATOR" "$bundle_id" >/dev/null 2>&1 || true
    sleep 1
    xcrun simctl launch "$FC_SIMULATOR" "$bundle_id" >/dev/null
    wait_companion_bridge "$FC_METRO_PORT" 30 \
      || fail_step "companion recipe bridge not ready after sim relaunch" 1
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
      --runtime-dir "$slot_repo/.sandbox/farmslot-farm/agent" \
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
# Fail fast: default 120s budget (override PHASE0_BUDGET_SEC). See #132.

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
phase0_budget_check "start"
ensure_feature_branch "$CC_WT" "$CC_BRANCH" "CC"
ensure_feature_branch "$FC_WT" "$FC_BRANCH" "FC"
prepare_cc_slot
phase0_budget_check "cc-slot"

export FARMSLOT_UI_URL="http://localhost:${VITE_PORT}/"
export FARMSLOT_CDP_PORT="$FF_CDP_PORT"
log "ensuring CDP Chrome for slot UI ${FARMSLOT_UI_URL} cdp :${FF_CDP_PORT}"
FARMSLOT_UI_URL="$FARMSLOT_UI_URL" FARMSLOT_CDP_PORT="$FF_CDP_PORT" \
  bash "$PRIMARY_REPO/apps/command-center/scripts/debug-chrome.sh" >>"$SCRATCH/e2e.log" 2>&1 \
  || fail_step "debug-chrome" $?
sleep 2
phase0_budget_check "debug-chrome"
ensure_cdp_chrome_visible
navigate_cdp_fleet
cdp_login_fleet
phase0_budget_check "cdp-login"

if [[ -n "${CAPTURE_HELPER_PATH:-}" ]]; then
  if CDP_PID="$(resolve_chrome_cdp_listener_pid "$FF_CDP_PORT")"; then
    "$CAPTURE_HELPER_PATH" snapshot --pid "$CDP_PID" -o "$SCRATCH/cdp-preflight.png" >>"$SCRATCH/e2e.log" 2>&1 \
      && log "capture-helper preflight snapshot ok (pid=$CDP_PID)" \
      || log "capture-helper preflight snapshot failed — video may be blocked by ScreenCaptureKit"
  else
    log "capture-helper preflight skipped — no Chrome listener on CDP :${FF_CDP_PORT}"
  fi
fi

if helper_bin="$(resolve_capture_helper_bin)"; then
  "$helper_bin" doctor --json >"$SCRATCH/phase0-capture-helper-doctor.json" 2>&1 || true
fi

node "$PRIMARY_REPO/apps/command-center/scripts/agentic/recipe-doctor.mjs" \
  --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" --json \
  >"$SCRATCH/phase0-doctor.json" 2>"$SCRATCH/phase0-doctor.err" \
  || fail_step "recipe-doctor" $?
log "doctor exit=0"
phase0_budget_check "recipe-doctor"

bash "$SCRIPT_DIR/validate-recipe.sh" --dry-run \
  --recipe "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" \
  --artifacts-dir "$SCRATCH/recipe-dry" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  >"$SCRATCH/phase0-dryrun.log" 2>&1 \
  || fail_step "validate-recipe dry-run" $?
log "dry-run exit=0"

prepare_companion_slot
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
phase0_budget_check "phase0-complete"
log "Phase 0 complete in $((SECONDS - PHASE0_STARTED_SEC))s (budget ${PHASE0_BUDGET_SEC}s)"

if [[ -n "${E2E_PHASE0_ONLY:-}" ]]; then
  log "E2E_PHASE0_ONLY set — stopping before Run A/B"
  exit 0
fi

# ── Run A (Command Center) ──────────────────────────────────────────────

if [[ -z "$TASK_DIR" || ! -d "$TASK_DIR" ]]; then
  fail_step "TASK_DIR missing under CC worktree (set TASK_DIR)" 1
fi
if [[ ! -f "$TASK_DIR/artifacts/recipe.json" ]]; then
  mkdir -p "$TASK_DIR/artifacts"
  cp "$PRIMARY_REPO/docs/examples/recipes/farmslot/demo-red-banner.recipe.json" "$TASK_DIR/artifacts/recipe.json"
fi

ensure_cdp_chrome_visible
navigate_cdp_fleet
run_recipe_proof "run A" "$CC_WT" "$TASK_DIR/artifacts/recipe.json" \
  "$TASK_DIR/artifacts/recipe-run" "$TASK_DIR" web "$SCRATCH/runA-proof.log" \
  --cdp-port "$FF_CDP_PORT" --gateway-port "$FF_GATEWAY_PORT" --slot-id "$FF_SLOT" \
  || fail_step "run A proof validate-recipe" $?
log "run A proof exit=0"

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

gateway_rpc() {
  local method="$1"
  local params="${2:-{}}"
  FARMSLOT_GATEWAY="${FARMSLOT_GATEWAY:-ws://127.0.0.1:${FF_GATEWAY_PORT}/ws}" \
    node "$PRIMARY_REPO/apps/command-center/scripts/cdp.mjs" gateway "$method" "$params" 2>>"$SCRATCH/e2e.log"
}

dispatch_autonomous_run() {
  local label="$1"
  local ticket="$2"
  local slot="$3"
  local branch="$4"
  local prepare_profile="$5"
  local app="${6:-}"
  local payload app_field=""
  if [[ -n "$app" ]]; then
    app_field=$(printf ',"app":"%s"' "$app")
  fi
  payload=$(printf '{"flowType":"dev","mode":"autonomous","project":"farmslot-farm","ticketOrPr":"%s","slotId":"%s","branch":"%s","prepareProfile":"%s"%s}' \
    "$ticket" "$slot" "$branch" "$prepare_profile" "$app_field")
  log "dispatching Track 1 $label ($ticket on $slot branch $branch)"
  local dispatch_log="$SCRATCH/track1-dispatch-${label}.json"
  gateway_rpc run.create "$payload" >"$dispatch_log" \
    || fail_step "Track 1 dispatch $label" 1
  python3 - <<'PY' "$dispatch_log"
import json, sys
data = json.load(open(sys.argv[1]))
run = data.get("run")
if run is None and isinstance(data.get("result"), dict):
    run = data["result"].get("run")
run_id = (run or {}).get("id")
if not run_id:
    raise SystemExit("run.create response missing run.id")
print(run_id)
PY
}

wait_run_blocked() {
  local label="$1"
  local run_id="$2"
  local started=$SECONDS
  local status=""
  while (( SECONDS - started < TRACK1_POLL_BUDGET_SEC )); do
    local poll_log="$SCRATCH/track1-poll-${label}.json"
    gateway_rpc run.get "$(printf '{"runId":"%s"}' "$run_id")" >"$poll_log" 2>/dev/null || true
    status="$(python3 - <<'PY' "$poll_log"
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    run = data.get("run")
    if run is None and isinstance(data.get("result"), dict):
        run = data["result"].get("run")
    print((run or {}).get("status", "unknown"))
except Exception:
    print("unknown")
PY
)"
    log "Track 1 $label poll: run=$run_id status=$status elapsed=$((SECONDS - started))s"
    case "$status" in
      blocked) printf '%s' "$run_id"; return 0 ;;
      done|failed|cancelled) fail_step "Track 1 $label run $run_id ended terminal ($status)" 1 ;;
    esac
    sleep 60
  done
  fail_step "Track 1 $label run $run_id exceeded ${TRACK1_POLL_BUDGET_SEC}s poll budget (last=$status)" 124
}

assert_gate_invariants() {
  local label="$1"
  local run_id="$2"
  GW_URL="${FARMSLOT_GATEWAY:-ws://127.0.0.1:${FF_GATEWAY_PORT}/ws}" \
    node "$PRIMARY_REPO/scripts/quality/assert-autonomous-gate-invariants.mjs" "$run_id" \
      >"$SCRATCH/track1-gate-${label}.log" 2>&1 \
      || fail_step "Track 1 gate invariants $label (see track1-gate-${label}.log)" 1
  log "Track 1 gate invariants exit=0 for $label run $run_id"
}

# Optional autonomous gate proof (set RUN_ID_FOR_GATE_CHECK to a live blocked run)
if [[ -n "${RUN_ID_FOR_GATE_CHECK:-}" ]]; then
  assert_gate_invariants "manual" "$RUN_ID_FOR_GATE_CHECK"
fi

if [[ -n "${E2E_TRACK1:-}" ]]; then
  log "E2E_TRACK1 set — dispatching autonomous Runs A/B to publication gate"
  RUN_A_ID="$(dispatch_autonomous_run "run-a" "$CC_TICKET" "$FF_SLOT" "$CC_BRANCH" "sandbox")"
  echo "$RUN_A_ID" >"$SCRATCH/runA-track1-id.txt"
  RUN_A_ID="$(wait_run_blocked "run-a" "$RUN_A_ID")"
  assert_gate_invariants "run-a" "$RUN_A_ID"
  RUN_B_ID="$(dispatch_autonomous_run "run-b" "$FC_TICKET" "$FC_SLOT" "$FC_BRANCH" "companion-warm" "companion")"
  echo "$RUN_B_ID" >"$SCRATCH/runB-track1-id.txt"
  RUN_B_ID="$(wait_run_blocked "run-b" "$RUN_B_ID")"
  assert_gate_invariants "run-b" "$RUN_B_ID"
  log "Track 1 complete — Run A=$RUN_A_ID Run B=$RUN_B_ID (blocked@human-gate, not approved)"
fi

log "e2e evidence capture complete — inspect $SCRATCH"