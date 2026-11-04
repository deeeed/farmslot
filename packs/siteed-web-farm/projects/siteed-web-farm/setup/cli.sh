#!/bin/bash
# One-time slot setup for siteed-web on the cli platform.
set -euo pipefail
SLOT_ID="${1:?Usage: cli.sh <slot-id> [branch]}"
BRANCH="${2:-main}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POOL_DIR="${SCRIPT_DIR}/../../../pool"
source "${SCRIPT_DIR}/../../../scripts/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
[ -e "${REPO}/.git" ] || { echo "FAIL: slot repo not found at ${REPO}"; exit 1; }
CUR="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
if [ "$CUR" = "$BRANCH" ] || [ -z "$(git -C "$REPO" status --porcelain)" -a "$CUR" = "HEAD" ]; then git -C "$REPO" checkout --quiet "$BRANCH"; else echo "SKIP checkout: slot is on $CUR (run in progress?)"; fi
mkdir -p "${REPO}/.agent"
command -v node >/dev/null && echo "PASS node: $(node -v)"
echo "=== siteed-web setup complete for ${SLOT_ID} ==="
