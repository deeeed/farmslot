#!/bin/bash
# cli.sh — one-time slot setup for example-app on the cli platform.
# Called by: bash scripts/setup-slot.sh <slot-id> [branch]
set -euo pipefail

SLOT_ID="${1:?Usage: cli.sh <slot-id> [branch]}"
BRANCH="${2:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POOL_DIR="${SCRIPT_DIR}/../../../pool"
source "${SCRIPT_DIR}/../../../scripts/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"

if [ ! -d "${REPO}/.git" ]; then
  echo "FAIL: slot repo not found at ${REPO} (project add clones it before setup)"
  exit 1
fi
echo "PASS repo: ${REPO}"

git -C "$REPO" checkout --quiet "$BRANCH"
echo "PASS branch: ${BRANCH}"

mkdir -p "${REPO}/.agent"
echo "PASS runtime dir: ${REPO}/.agent"

echo "=== example-app setup complete for ${SLOT_ID} ==="
