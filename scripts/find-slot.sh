#!/usr/bin/env bash
# find-slot.sh — Find the best available slot for a project.
#
# Reads .farm-status.json (cached by farm-status.sh), filters by project,
# returns the best available slot.
#
# Usage:
#   bash scripts/find-slot.sh --project example-mobile-farm
#   bash scripts/find-slot.sh --project example-mobile-farm --prefer-cdp
#   bash scripts/find-slot.sh --slot runner-mobile-1   # validate a user-specified slot
#
# Output (stdout): slot ID (e.g. "runner-mobile-1") or empty + exit 1
# Exit codes: 0 = found, 1 = no slot available (prints reason to stderr)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATUS_FILE="${PROJECT_DIR}/.farm-status.json"

# -- Options ---------------------------------------------------------------
PROJECT=""
SLOT=""
PREFER_CDP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)    PROJECT="$2"; shift 2 ;;
    --slot)       SLOT="$2"; shift 2 ;;
    --prefer-cdp) PREFER_CDP=true; shift ;;
    -h|--help)
      echo "Usage: find-slot.sh --project <name> [--prefer-cdp]"
      echo "       find-slot.sh --slot <slot-id>"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] && [ -z "$SLOT" ]; then
  echo "Error: --project or --slot required" >&2
  exit 1
fi

if [ ! -f "$STATUS_FILE" ]; then
  echo "No cached status. Run farm-status.sh first." >&2
  exit 1
fi

# -- Selection logic (python3 for JSON parsing) ----------------------------
python3 -c "
import json, sys

with open('${STATUS_FILE}') as f:
    data = json.load(f)

slots = data.get('slots', [])
project = '${PROJECT}'
slot_id = '${SLOT}'
prefer_cdp = '${PREFER_CDP}' == 'true'

def is_free(s):
    \"\"\"A slot is free if it can accept a new task.\"\"\"
    if s.get('mode', 'dispatch') != 'dispatch':
        return False
    if s.get('lifecycle') not in ('ready', 'released'):
        return False
    if s.get('agent') in ('working',):
        return False
    return True

def cdp_live(s):
    \"\"\"CDP is live if it has a meaningful value (not OFF/dash/FAIL).\"\"\"
    cdp = s.get('cdp', '-')
    return cdp not in ('OFF', '-', 'FAIL', 'Other')

def sort_key(s):
    \"\"\"Sort slots by preference (lower = better).\"\"\"
    score = 0
    # 1. CDP live preferred
    if not cdp_live(s):
        score += 100
    # 2. ready > released
    if s.get('lifecycle') != 'ready':
        score += 10
    # 3. Device OK preferred
    dev = s.get('dev', '-')
    if not dev.endswith(':OK'):
        score += 5
    # 4. Fixtures OK preferred
    if s.get('fixtures') != 'OK':
        score += 1
    return score

# -- Validate mode ---------------------------------------------------------
if slot_id:
    match = [s for s in slots if s['slot'] == slot_id]
    if not match:
        print(f'Slot {slot_id} not found in status cache.', file=sys.stderr)
        sys.exit(1)
    s = match[0]
    mode = s.get('mode', 'dispatch')
    lifecycle = s.get('lifecycle', '-')
    agent = s.get('agent', '-')
    if mode == 'disabled':
        print(f'Slot {slot_id} is disabled.', file=sys.stderr)
        sys.exit(1)
    if mode == 'custom':
        print(f'Slot {slot_id} is in custom mode.', file=sys.stderr)
        sys.exit(1)
    if agent == 'working':
        print(f'Slot {slot_id} agent is working.', file=sys.stderr)
        sys.exit(1)
    if lifecycle in ('working', 'dispatching'):
        print(f'Slot {slot_id} lifecycle is {lifecycle}.', file=sys.stderr)
        sys.exit(1)
    # Slot is usable
    print(slot_id)
    sys.exit(0)

# -- Find best slot for project -------------------------------------------
candidates = [s for s in slots if s.get('project') == project and is_free(s)]

if not candidates:
    # Give a useful reason
    project_slots = [s for s in slots if s.get('project') == project]
    if not project_slots:
        print(f'No slots found for project {project}.', file=sys.stderr)
    else:
        reasons = []
        for s in project_slots:
            mode = s.get('mode', 'dispatch')
            lifecycle = s.get('lifecycle', '-')
            agent = s.get('agent', '-')
            if mode != 'dispatch':
                reasons.append(f\"{s['slot']}: mode={mode}\")
            elif agent == 'working':
                reasons.append(f\"{s['slot']}: agent working\")
            elif lifecycle not in ('ready', 'released'):
                reasons.append(f\"{s['slot']}: lifecycle={lifecycle}\")
            else:
                reasons.append(f\"{s['slot']}: unknown\")
        print(f'All {project} slots occupied:', file=sys.stderr)
        for r in reasons:
            print(f'  {r}', file=sys.stderr)
    sys.exit(1)

# Sort by preference
candidates.sort(key=sort_key)

# If --prefer-cdp, filter to CDP-live if any exist
if prefer_cdp:
    cdp_candidates = [s for s in candidates if cdp_live(s)]
    if cdp_candidates:
        candidates = cdp_candidates

print(candidates[0]['slot'])
"
