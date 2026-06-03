#!/bin/bash
# check-slot.sh <slot-id>
# Delegates to farmslot CLI.
#
# Usage:
#   bash scripts/check-slot.sh runner-mobile-1
SLOT_ID="${1:?Usage: check-slot.sh <slot-id>}"
FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"
exec "$FARMSLOT" slot check "$SLOT_ID"
