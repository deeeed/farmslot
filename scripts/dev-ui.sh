#!/usr/bin/env bash
set -euo pipefail

# Keep the operator reload policy in this UI child, out of gateway/node-launched sandboxes.
export FARMSLOT_DEV_UI_HMR="${FARMSLOT_DEV_UI_HMR:-${FARMSLOT_DISABLE_ORCHESTRATION:-0}}"
cd "$(dirname "$0")/../apps/command-center/ui"
exec yarn dev
