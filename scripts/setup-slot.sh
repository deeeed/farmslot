#!/bin/bash
# setup-slot.sh <slot-id> [branch]
# One-time machine bootstrap for a slot. Delegates to the project's
# setup/<platform>.sh script (e.g. projects/example-mobile-farm/setup/android.sh).
#
# This is NOT run on every dispatch — only when setting up a new machine/slot
# for the first time (install deps, create emulators, clone repo, build app).
#
# Usage:
#   bash scripts/setup-slot.sh runner-mobile-1 main
#   bash scripts/setup-slot.sh runner-local-1 main
set -euo pipefail

SLOT_ID="${1:?Usage: setup-slot.sh <slot-id> [branch]}"
BRANCH="${2:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
load_project_config || { echo "FAIL: no project config for ${SLOT_ID}"; exit 1; }

SETUP_DIR="${PROJECTS_DIR}/${PROJECT_NAME}/setup"
SETUP_SCRIPT="${SETUP_DIR}/${PLATFORM}.sh"

if [ ! -f "$SETUP_SCRIPT" ]; then
  echo "FAIL: setup script not found: ${SETUP_SCRIPT}"
  echo ""
  echo "Expected: projects/${PROJECT_NAME}/setup/${PLATFORM}.sh"
  echo "This script should bootstrap the machine for ${PLATFORM} slots."
  exit 1
fi

banner "=== Setup: ${SLOT_ID} on ${MACHINE} (${PLATFORM}) ==="
echo "  project:  ${PROJECT_NAME}"
echo "  platform: ${PLATFORM}"
echo "  branch:   ${BRANCH}"
echo "  script:   ${SETUP_SCRIPT}"
echo ""

bash "$SETUP_SCRIPT" "$SLOT_ID" "$BRANCH"
