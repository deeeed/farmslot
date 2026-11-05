#!/usr/bin/env bash
set -euo pipefail

gateway_script=start
if [[ "${FARMSLOT_DISABLE_ORCHESTRATION:-}" == "1" ]]; then
  gateway_script=dev
fi
# Isolated source-watch stacks already have tsx's own restart owner.
if [[ "$gateway_script" == dev ]]; then
  exec yarn workspace @farmslot/gateway dev
fi
exec node "$(dirname "$0")/gateway-supervisor.mjs" yarn workspace @farmslot/gateway start
