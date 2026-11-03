#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${FARMSLOT_NODE_NATIVE_OWNER_PRINCIPAL_ID+x}" ]]; then
  export FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID="$FARMSLOT_NODE_NATIVE_OWNER_PRINCIPAL_ID"
fi
exec yarn workspace @farmslot/node dev
