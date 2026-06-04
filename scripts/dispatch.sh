#!/bin/bash
# dispatch.sh <slot-id> <task-file> [--skip-prepare]
# Delegates to the Farmslot run CLI.
#
# Usage:
#   bash scripts/dispatch.sh runner-mobile-1 projects/example-mobile-farm/tasks/fix/proj-2236-0321-1350/TASK.md
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FARMSLOT="${SCRIPT_DIR}/../packages/cli/bin/farmslot.mjs"

# Parse positional + optional args (dispatch.sh supports mixed order)
SLOT_ID=""
TASK_FILE=""
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-prepare) EXTRA_ARGS+=("$arg") ;;
    --force) echo "dispatch.sh no longer supports --force; use farmslot run create --task <TASK.md> --slot <slot-id>" >&2; exit 1 ;;
    *)
      if [ -z "$SLOT_ID" ]; then SLOT_ID="$arg"
      elif [ -z "$TASK_FILE" ]; then TASK_FILE="$arg"
      fi ;;
  esac
done

[ -z "$SLOT_ID" ] || [ -z "$TASK_FILE" ] && { echo "Usage: dispatch.sh <slot-id> <task-file> [--skip-prepare]"; exit 1; }

# Resolve relative task file paths (relative to project root)
if [[ "$TASK_FILE" != /* ]]; then
  TASK_FILE="${PROJECT_DIR}/${TASK_FILE}"
fi

exec "$FARMSLOT" run create --slot "$SLOT_ID" --task "$TASK_FILE" "${EXTRA_ARGS[@]}"
