#!/bin/bash
# release-slot.sh <slot-id> [--keep-warm] [--reset] [--skip-artifacts] [--keep-work] [--kill-tmux]
# Delegates to farmslot CLI.
#
# Usage:
#   bash scripts/release-slot.sh runner-mobile-1
#   bash scripts/release-slot.sh runner-mobile-1 --keep-warm
#   bash scripts/release-slot.sh runner-mobile-1 --keep-work
#   bash scripts/release-slot.sh runner-mobile-1 --reset
SLOT_ID="${1:?Usage: release-slot.sh <slot-id> [--keep-warm] [--reset] [--skip-artifacts] [--keep-work] [--kill-tmux]}"
shift
FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"
exec "$FARMSLOT" slot release "$SLOT_ID" "$@"
