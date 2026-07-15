#!/bin/bash
# Shim: use `farmslot slot prepare`. Kept as of 2026-07-15 because the metamask-mobile/
# extension pack READMEs and core-farm docs still print this path; delete once those
# packs repoint to the CLI (team-repo PRs).
# prepare-slot.sh <slot-id> [--branch <name>] [--merge-main] [--flow-type <type>] [--app <path>] [--var key=value ...]
# Delegates to farmslot CLI.
#
# Usage:
#   bash scripts/prepare-slot.sh runner-mobile-1
#   bash scripts/prepare-slot.sh runner-mobile-1 --branch fix/perps/proj-2236
#   bash scripts/prepare-slot.sh runner-mobile-1 --branch fix/perps/percentage --merge-main
#   bash scripts/prepare-slot.sh runner-browser-1 --branch main --var mode=sidepanel
#
# --var key=value is repeatable. Each pair is exported to the project's preflight
# hook as FARMSLOT_VAR_<UPPERCASE_KEY>. The framework does not interpret values;
# projects define their own keys. Example: example-browser-farm reads
# FARMSLOT_VAR_MODE (fullscreen|sidepanel) to choose the browser launch shape.
SLOT_ID="${1:?Usage: prepare-slot.sh <slot-id> [--branch <name>] [--merge-main] [--flow-type <type>] [--app <path>] [--var key=value ...]}"
shift
FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"
echo "note: prepare-slot.sh is deprecated; use \`farmslot slot prepare\`" >&2
exec "$FARMSLOT" slot prepare "$SLOT_ID" "$@"
