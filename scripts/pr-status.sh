#!/usr/bin/env bash
# pr-status.sh — Delegates to farmslot CLI.
#
# Usage:
#   pr-status.sh                  # Auto-discover PRs from active slots
#   pr-status.sh --pr 27600       # Check specific PR
#   pr-status.sh --json           # Machine-readable JSON
#   pr-status.sh --human          # Human-readable (default if tty)
FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"

EXPLICIT_PR=""
JSON_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)    EXPLICIT_PR="$2"; shift 2 ;;
    --json)  JSON_FLAG="--json"; shift ;;
    --human) JSON_FLAG=""; shift ;;
    --since) shift 2 ;; # ignored (backward compat)
    -h|--help)
      echo "Usage: pr-status.sh [--pr <N>] [--json|--human]"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Auto-detect JSON for piped output
if [ -z "$JSON_FLAG" ] && [ ! -t 1 ]; then
  JSON_FLAG="--json"
fi

if [ -n "$EXPLICIT_PR" ]; then
  exec "$FARMSLOT" $JSON_FLAG pr status "$EXPLICIT_PR"
else
  exec "$FARMSLOT" $JSON_FLAG pr list
fi
