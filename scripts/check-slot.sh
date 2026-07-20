#!/bin/bash
# Shim: use `farmslot slot check`. Kept as of 2026-07-15 because some external pack
# READMEs still print this path; delete once those packs repoint to the CLI.
# check-slot.sh <slot-id>
# Delegates to farmslot CLI.
#
# Usage:
#   bash scripts/check-slot.sh runner-mobile-1
SLOT_ID="${1:?Usage: check-slot.sh <slot-id>}"
FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"
echo "note: check-slot.sh is deprecated; use \`farmslot slot check\`" >&2
exec "$FARMSLOT" slot check "$SLOT_ID"
