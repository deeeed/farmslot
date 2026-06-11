#!/bin/bash
# preflight-slot.sh <slot-id> [--app <path>]
# Runs from the orchestrator (macbook, operator repo).
# Verifies a remote slot is ready for agent dispatch: fixtures synced,
# emulator/simulator running, dev server on correct port, health check live.
#
# Usage:
#   bash scripts/preflight-slot.sh runner-mobile-1
#   bash scripts/preflight-slot.sh runner-local-1 --app apps/sherpa-voice
set -euo pipefail

SLOT_ID="${1:?Usage: preflight-slot.sh <slot-id>}"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:?--app requires a value}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

# -- Source shared helpers + load config -----------------------------------
source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
load_project_config || true

DEV_SERVER_NAME=$(get_project_field "health.dev_server_name")
DEV_SERVER_NAME="${DEV_SERVER_NAME:-DevServer}"
READY_INDICATOR=$(get_project_field "health.ready_indicator")
DEV_SERVER_LOG=$(get_project_field "health.dev_server_log")

FAILURES=()

echo -e "${BOLD}=== Preflight: ${SLOT_ID} on ${MACHINE} (${PLATFORM}) ===${NC}"
echo "  host:     ${SSH_TARGET}"
echo "  repo:     ${REMOTE_REPO}"
echo "  project:  ${PROJECT_NAME}"
echo "  session:  ${SESSION}"
echo "  ${DEV_SERVER_NAME,,}: port ${METRO_PORT}"
echo "  watcher:  ${WATCHER_PORT}"
if [ "$PLATFORM" = "android" ]; then
  echo "  adb:      ${ADB_SERIAL}"
elif [ "$PLATFORM" = "ios" ]; then
  echo "  sim:      ${IOS_SIMULATOR}"
else
  echo "  platform: ${PLATFORM}"
fi
echo ""

# -- 1. SSH connectivity --------------------------------------------------
header "SSH"
if remote "echo ok" >/dev/null 2>&1; then
  pass "SSH to ${SSH_TARGET}"
else
  fail "Cannot SSH to ${SSH_TARGET}"
  FAILURES+=("Cannot SSH to ${SSH_TARGET}")
  echo -e "\n${RED}Cannot reach host — aborting.${NC}"
  exit 1
fi

# -- 2. Repo exists -------------------------------------------------------
header "Repo"
if remote "test -d '${REMOTE_REPO}/.git'"; then
  pass "Repo exists at ${REMOTE_REPO}"
else
  fail "Repo not found at ${REMOTE_REPO}"
  FAILURES+=("Repo not found at ${REMOTE_REPO}")
fi

# -- 3. Validate fixtures (checksum comparison, no sync) -------------------
header "Fixtures"
FIXTURE_MISMATCHES=()

check_fixture() {
  local name="$1" local_path="$2" remote_path="$3"
  local local_md5 remote_md5

  local_md5=$(md5 -q "$local_path" 2>/dev/null || md5sum "$local_path" 2>/dev/null | awk '{print $1}')
  remote_md5=$(remote "md5sum '${remote_path}' 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)
  if [ -z "$remote_md5" ]; then
    remote_md5=$(remote "md5 -q '${remote_path}' 2>/dev/null" 2>/dev/null || true)
  fi

  if [ -z "$remote_md5" ]; then
    warn "${name} — missing on worker"
    FIXTURE_MISMATCHES+=("${name} (missing)")
  elif [ "$local_md5" = "$remote_md5" ]; then
    pass "${name} — ${local_md5:0:8}"
  else
    warn "${name} — mismatch (expected ${local_md5:0:8}, got ${remote_md5:0:8})"
    FIXTURE_MISMATCHES+=("${name} (expected ${local_md5:0:8} got ${remote_md5:0:8})")
  fi
}

# Check templates (with var substitution)
if [ -n "$PROJECT_JSON" ]; then
  # Guard the seq loops: BSD seq counts DOWN from 0 to -1 when the list is empty.
  TEMPLATE_COUNT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('fixtures',{}).get('templates',[])))")
  if [ "$TEMPLATE_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((TEMPLATE_COUNT - 1))); do
    TPL_SRC=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['templates'][$i]['src'])")
    TPL_DST=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['templates'][$i]['dst'])")
    LOCAL_TPL="${PROJECT_FIXTURES_DIR}/${TPL_SRC}"
    if [ -f "$LOCAL_TPL" ]; then
      RENDERED=$(render_fixture_template "$LOCAL_TPL")
      check_fixture "$TPL_DST" "$RENDERED" "${REMOTE_REPO}/${TPL_DST}"
      rm -f "$RENDERED"
    else
      warn "${TPL_SRC} template not found at ${LOCAL_TPL}"
      FIXTURE_MISMATCHES+=("${TPL_SRC} (template missing locally)")
    fi
  done
  fi

  # Check plain files
  FILE_COUNT=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('fixtures',{}).get('files',[])))")
  if [ "$FILE_COUNT" -gt 0 ]; then
  for i in $(seq 0 $((FILE_COUNT - 1))); do
    FILE_SRC=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['files'][$i]['src'])")
    FILE_DST=$(echo "$PROJECT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['fixtures']['files'][$i]['dst'])")
    LOCAL_FILE="${PROJECT_FIXTURES_DIR}/${FILE_SRC}"
    if [ -f "$LOCAL_FILE" ]; then
      check_fixture "$FILE_DST" "$LOCAL_FILE" "${REMOTE_REPO}/${FILE_DST}"
    else
      warn "${FILE_SRC} not found in fixtures"
    fi
  done
  fi
fi

if [ ${#FIXTURE_MISMATCHES[@]} -gt 0 ]; then
  warn "${#FIXTURE_MISMATCHES[@]} fixture(s) out of sync — run sync-fixtures.sh to update"
fi

# -- 4. Emulator / Simulator running --------------------------------------
header "Device"
DEVICE_CHECK=$(expand_platform_field "device_check")
if [ -n "$DEVICE_CHECK" ]; then
  if remote "${DEVICE_CHECK}"; then
    if [ "$PLATFORM" = "android" ]; then
      pass "Emulator ${ADB_SERIAL} running"
    elif [ "$PLATFORM" = "ios" ]; then
      pass "Simulator ${IOS_SIMULATOR} booted"
    else
      pass "Device check passed (${PLATFORM})"
    fi
  else
    if [ "$PLATFORM" = "android" ]; then
      fail "Emulator ${ADB_SERIAL} not found in adb devices"
      FAILURES+=("Emulator ${ADB_SERIAL} not found")
    elif [ "$PLATFORM" = "ios" ]; then
      fail "Simulator ${IOS_SIMULATOR} not booted"
      FAILURES+=("Simulator ${IOS_SIMULATOR} not booted")
    else
      fail "Device check failed (${PLATFORM})"
      FAILURES+=("Device check failed (${PLATFORM})")
    fi
  fi
else
  info "No device check configured for platform ${PLATFORM}"
fi

# -- 5. Dev server running -------------------------------------------------
header "${DEV_SERVER_NAME}"
DEV_CHECK=$(expand_hook "dev_server_check")
if [ -n "$DEV_CHECK" ]; then
  if remote "${DEV_CHECK}"; then
    pass "${DEV_SERVER_NAME} running on port ${METRO_PORT}"
  else
    fail "${DEV_SERVER_NAME} not running on port ${METRO_PORT}"
    FAILURES+=("${DEV_SERVER_NAME} not running on port ${METRO_PORT}")
  fi
else
  info "No dev_server_check hook configured"
fi

if [ -n "$DEV_SERVER_LOG" ]; then
  if remote "find '${REMOTE_REPO}/${DEV_SERVER_LOG}' -mmin -5 2>/dev/null | grep -q ."; then
    pass "${DEV_SERVER_LOG} is recent"
  else
    warn "${DEV_SERVER_LOG} missing or stale (>5 min old)"
  fi
fi

# -- 6. Health check -------------------------------------------------------
HEALTH_HOOK=$(expand_hook "health_check")
if [ -n "$HEALTH_HOOK" ]; then
  header "Health"
  CDP_OK=false

  parse_health_value() {
    local parse_cmd
    parse_cmd=$(get_project_field "health.parse_health")
    [ -z "$parse_cmd" ] && return 0
    echo "$1" | eval "$parse_cmd" 2>/dev/null || true
  }

  HEALTH_OUTPUT=$(remote "cd '${REMOTE_REPO}' && ${HEALTH_HOOK} 2>/dev/null" 2>/dev/null || true)
  HEALTH_VALUE=$(parse_health_value "$HEALTH_OUTPUT")
  if [ -n "$HEALTH_VALUE" ]; then
    if [ -z "$READY_INDICATOR" ] || [ "$HEALTH_VALUE" = "$READY_INDICATOR" ]; then
      pass "Health — ${HEALTH_VALUE}"
      CDP_OK=true
    else
      warn "Health responds but value=${HEALTH_VALUE} (expected ${READY_INDICATOR}) — trying unlock"
    fi
  else
    warn "Health not responding — trying unlock"
  fi

  if [ "$CDP_OK" = false ]; then
    UNLOCK_HOOK=$(expand_hook "unlock")
    if [ -n "$UNLOCK_HOOK" ]; then
      remote "cd '${REMOTE_REPO}' && ${UNLOCK_HOOK} 2>&1" 2>/dev/null || true
      sleep 3
      HEALTH_OUTPUT2=$(remote "cd '${REMOTE_REPO}' && ${HEALTH_HOOK} 2>/dev/null" 2>/dev/null || true)
      HEALTH_VALUE2=$(parse_health_value "$HEALTH_OUTPUT2")
      if [ -n "$HEALTH_VALUE2" ] && { [ -z "$READY_INDICATOR" ] || [ "$HEALTH_VALUE2" = "$READY_INDICATOR" ]; }; then
        pass "Health after unlock — ${HEALTH_VALUE2}"
        CDP_OK=true
      else
        fail "Health not responding (unlock attempted)"
        FAILURES+=("Health not responding")
      fi
    else
      fail "Health not responding (no unlock hook)"
      FAILURES+=("Health not responding")
    fi
  fi
fi

# -- 7. Clean stale temp files --------------------------------------------
header "Cleanup"
STALE=$(remote "cd '${REMOTE_REPO}' && ls benchmark-report.md 2>/dev/null" 2>/dev/null || true)
if [ -n "$STALE" ]; then
  remote "cd '${REMOTE_REPO}' && rm -f benchmark-report.md 2>/dev/null" 2>/dev/null || true
  pass "Cleaned: ${STALE//$'\n'/, }"
else
  pass "No stale files"
fi

# -- 8. tmux session -------------------------------------------------------
header "tmux"
if remote "tmux has-session -t '${SESSION}' 2>/dev/null"; then
  pass "tmux session ${SESSION} exists"
else
  warn "tmux session ${SESSION} not found — creating"
  remote "tmux new-session -d -s '${SESSION}' -c '${REMOTE_REPO}'"
  pass "tmux session ${SESSION} created"
fi

# -- Report ----------------------------------------------------------------
echo ""
if [ ${#FAILURES[@]} -eq 0 ] && [ ${#FIXTURE_MISMATCHES[@]} -eq 0 ]; then
  echo -e "${GREEN}${BOLD}=== SLOT ${SLOT_ID} READY ===${NC}"
  echo "  Machine:  ${MACHINE} (${PLATFORM})"
  echo "  Host:     ${SSH_TARGET}"
  echo "  Repo:     ${REMOTE_REPO}"
  echo "  Project:  ${PROJECT_NAME}"
  echo "  Session:  ${SESSION}"
  echo "  ${DEV_SERVER_NAME}: port ${METRO_PORT}"
  [ -n "$READY_INDICATOR" ] && echo "  Health:   ${READY_INDICATOR}"
  if [ -n "$CLAUDE_PATH" ]; then
    echo "  Agent:    ${CLAUDE_PATH}"
  fi
  exit 0
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo -e "${RED}${BOLD}=== SLOT ${SLOT_ID} NOT READY (${#FAILURES[@]} failures) ===${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}x${NC} $f"
  done
fi

# -- Next steps ------------------------------------------------------------
echo ""
header "Fix"

if [ ${#FIXTURE_MISMATCHES[@]} -gt 0 ]; then
  echo -e "  ${YELLOW}# 1. Sync fixtures${NC}"
  echo "  bash ${SCRIPT_DIR}/sync-fixtures.sh --slot ${SLOT_ID}"
  echo ""
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo -e "  ${YELLOW}# 2. Run preflight on worker${NC}"
  PREFLIGHT_HOOK=$(expand_hook "preflight")
  if [ -n "$PREFLIGHT_HOOK" ]; then
    echo "  ssh -t ${SSH_TARGET} 'cd ${REMOTE_REPO} && ${PREFLIGHT_HOOK}'"
  else
    echo "  # No preflight hook configured in project.json"
  fi
  echo ""
fi

echo -e "  ${YELLOW}# 3. Re-check${NC}"
echo "  bash ${SCRIPT_DIR}/preflight-slot.sh ${SLOT_ID}"

exit 1
