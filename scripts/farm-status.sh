#!/usr/bin/env bash
# farm-status.sh — Farm-wide status overview across all machines and slots.
# Thin wrapper — collect mode delegates to gateway via gw CLI.
#
# Usage:
#   farm-status.sh                # Collect + display table
#   farm-status.sh --show         # Display from cache (no SSH, instant)
#   farm-status.sh --slot <id>    # Deep check (delegates to check-slot.sh)
#   farm-status.sh --sync <id>    # Sync fixtures (delegates to sync-fixtures.sh)
#   farm-status.sh --json         # Output raw JSON cache

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATUS_FILE="${PROJECT_DIR}/.farm-status.json"
FARMSLOT="$(cd "${SCRIPT_DIR}/../packages/cli" && pwd)/bin/farmslot.mjs"

# -- Options ---------------------------------------------------------------
MODE="collect"
SLOT_ARG=""
SYNC_EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --show)  MODE="show"; shift ;;
    --slot)  MODE="slot"; SLOT_ARG="$2"; shift 2 ;;
    --sync)  MODE="sync"; SLOT_ARG="$2"; shift 2; SYNC_EXTRA=("$@"); set -- ;;
    --json)  MODE="json"; shift ;;
    --prepare-all) MODE="prepare-all"; shift ;;
    --sync-all)    MODE="sync-all"; shift ;;
    --recycle-all) MODE="recycle-all"; shift ;;
    -h|--help)
      echo "Usage: farm-status.sh [--show] [--slot <id>] [--sync <id>] [--json]"
      echo "       farm-status.sh --prepare-all | --sync-all | --recycle-all"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# -- Delegate modes --------------------------------------------------------
if [ "$MODE" = "slot" ]; then
  exec "$FARMSLOT" slot check "${SLOT_ARG}"
fi
if [ "$MODE" = "sync" ]; then
  exec bash "${SCRIPT_DIR}/sync-fixtures.sh" --slot "${SLOT_ARG}" "${SYNC_EXTRA[@]}"
fi
if [ "$MODE" = "json" ]; then
  # The CLI --json output is now a machine envelope; keep this script's
  # long-standing raw fleet-status shape for existing consumers.
  "$FARMSLOT" --json fleet status | jq '.data // .'
  exit "${PIPESTATUS[0]}"
fi
if [ "$MODE" = "show" ]; then
  exec "$FARMSLOT" fleet status
fi

# -- Batch action modes (read from cached JSON) ----------------------------
if [[ "$MODE" =~ ^(prepare|sync|recycle)-all$ ]]; then
  [ -f "$STATUS_FILE" ] || { echo "No cached status." >&2; exit 1; }
  ACTION="${MODE%-all}"
  BATCH_SLOTS=$(python3 -c "
import json
with open('${STATUS_FILE}') as f:
    data = json.load(f)
for s in data.get('slots', []):
    mode = s.get('mode', 'dispatch')
    if mode == 'disabled': continue
    ssh_ok = s.get('ssh') in ('OK', 'LOCAL')
    if '${ACTION}' == 'prepare':
        if mode == 'custom': continue
        if s.get('lifecycle') in ('released',) or (ssh_ok and s.get('agent') != 'working' and not s.get('dispatchable')):
            print(s['slot'])
    elif '${ACTION}' == 'sync':
        if ssh_ok and s.get('fixtures') not in ('OK', '-'):
            print(s['slot'])
    elif '${ACTION}' == 'recycle':
        if mode == 'custom': continue
        if s.get('lifecycle') in ('done',):
            print(s['slot'])
" 2>/dev/null)

  if [ -z "$BATCH_SLOTS" ]; then
    echo "No slots need ${ACTION}."
    exit 0
  fi

  COUNT=$(echo "$BATCH_SLOTS" | wc -l | tr -d ' ')
  echo "Running ${ACTION} on ${COUNT} slot(s):"
  echo "$BATCH_SLOTS" | sed 's/^/  /'
  echo ""

  FAILED=0
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    case "$ACTION" in
      prepare) bash "${SCRIPT_DIR}/prepare-slot.sh" "$sid" ;;
      sync)    bash "${SCRIPT_DIR}/sync-fixtures.sh" --slot "$sid" ;;
      recycle) bash "${SCRIPT_DIR}/release-slot.sh" "$sid" --keep-warm --reset ;;
    esac
    [ $? -ne 0 ] && { echo "WARN: ${ACTION} failed for ${sid}" >&2; FAILED=$((FAILED + 1)); }
  done <<< "$BATCH_SLOTS"

  echo ""
  if [ "$FAILED" -gt 0 ]; then
    echo "${ACTION} complete: $((COUNT - FAILED))/${COUNT} succeeded, ${FAILED} failed."
    exit 1
  else
    echo "${ACTION} complete: ${COUNT}/${COUNT} succeeded."
  fi
  exit 0
fi

# -- Collect mode: refresh + display via farmslot CLI ---------------------
exec "$FARMSLOT" fleet refresh
