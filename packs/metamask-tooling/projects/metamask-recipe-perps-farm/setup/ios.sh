#!/usr/bin/env bash
# The pack keeps one tooling implementation in metamask-harness-farm; this
# project's slots run it with their own kind. Register the whole pack.
set -euo pipefail
shared="$(cd "$(dirname "$0")/../.." && pwd)/metamask-harness-farm/setup/ios.sh"
[ -f "$shared" ] || { echo "FAIL: metamask-harness-farm is not registered; add the whole metamask-tooling pack"; exit 1; }
exec bash "$shared" "${1:?Usage: ios.sh <slot-id> [branch]}" "${2:-main}" recipe-perps
