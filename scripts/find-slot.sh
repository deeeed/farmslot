#!/usr/bin/env bash
# find-slot.sh — Find the best available slot for a project.
#
# Thin wrapper around `farmslot fleet find-slot`. CDP preference is now
# inherent in the slot scoring; --prefer-cdp is accepted but ignored.
#
# Usage:
#   bash scripts/find-slot.sh --project example-mobile-farm
#   bash scripts/find-slot.sh --slot runner-mobile-1   # validate a user-specified slot
#
# Output (stdout): slot ID (e.g. "runner-mobile-1") or empty + exit 1
# Exit codes: 0 = found, 1 = no slot available (prints reason to stderr)

FARMSLOT_CLI="${FARMSLOT_CLI:-$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs}"

# -- Options ---------------------------------------------------------------
PROJECT=""
SLOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)    PROJECT="$2"; shift 2 ;;
    --slot)       SLOT="$2"; shift 2 ;;
    --prefer-cdp)
      echo "find-slot: --prefer-cdp is deprecated; CDP preference is inherent in slot scoring." >&2
      shift ;;
    -h|--help)
      echo "Usage: find-slot.sh --project <name> [--prefer-cdp]"
      echo "       find-slot.sh --slot <slot-id>"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] && [ -z "$SLOT" ]; then
  echo "Error: --project or --slot required" >&2
  exit 1
fi

# --raw keeps the historical bare-slot-id stdout contract (errors go to the
# envelope on stdout with exit 1, which callers already treat as failure).
exec "$FARMSLOT_CLI" fleet find-slot --raw \
  ${PROJECT:+--project "$PROJECT"} \
  ${SLOT:+--slot "$SLOT"}
