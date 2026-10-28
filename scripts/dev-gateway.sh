#!/usr/bin/env bash
set -euo pipefail

gateway_script=start
if [[ "${FARMSLOT_DISABLE_ORCHESTRATION:-}" == "1" ]]; then
  gateway_script=dev
fi
exec yarn workspace @farmslot/gateway "$gateway_script"
