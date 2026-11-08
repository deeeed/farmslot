#!/usr/bin/env bash
# One-time bootstrap for every MetaMask tooling slot in this pack: verify the tooling checkout,
# Node 22 and the published harness, then create this slot's own simulator.
# Called by: bash scripts/setup-slot.sh <slot-id> [branch]
set -euo pipefail

SLOT_ID="${1:?Usage: ios.sh <slot-id> [branch] [kind]}"
BRANCH="${2:-main}"
# The pack's other projects delegate here with their own kind.
KIND="${3:-harness}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FARMSLOT_DIR="$(cd "${PROJECT_DIR}/../.." && pwd)"
POOL_DIR="${FARMSLOT_DIR}/pool"
source "${FARMSLOT_DIR}/scripts/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"


[ -d "${REPO}/.git" ] || { echo "FAIL: slot repo not found at ${REPO}"; exit 1; }
git -C "$REPO" checkout --quiet "$BRANCH"
echo "PASS repo ${REPO} on ${BRANCH}"

bash "${PROJECT_DIR}/scripts/tooling.sh" prerequisites "$KIND" "$REPO" ""
bash "${PROJECT_DIR}/scripts/tooling.sh" install "$KIND" "$REPO"

# The slot owns its simulator; it is created here, never borrowed.
[ -n "${IOS_SIMULATOR:-}" ] || { echo "FAIL: slot ${SLOT_ID} has no ios-sim resource"; exit 1; }
if xcrun simctl list devices | grep -q "${IOS_SIMULATOR} ("; then
  echo "PASS simulator ${IOS_SIMULATOR} exists"
else
  RUNTIME="$(xcrun simctl list runtimes | awk '/iOS/ && /com.apple/ {id=$NF} END {print id}')"
  [ -n "$RUNTIME" ] || { echo "FAIL: no iOS runtime installed"; exit 1; }
  xcrun simctl create "${IOS_SIMULATOR}" com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro "$RUNTIME" >/dev/null
  echo "PASS simulator ${IOS_SIMULATOR} created (${RUNTIME})"
fi

echo "=== ${KIND} tooling setup complete for ${SLOT_ID} ==="
