#!/bin/bash
# session-usage.sh — Token usage tracking for worker runner sessions
# Delegates to farmslot CLI (packages/slot-config session-usage core).
#
# Usage:
#   bash scripts/session-usage.sh <slot-id> snapshot
#   bash scripts/session-usage.sh <slot-id> report
#   bash scripts/session-usage.sh <slot-id> total
#
# Env vars honoured (all flow through exec automatically):
#   RUNNER_SESSION_PATH    Force a specific transcript file/directory
#   RUNNER_SESSION_RUNNER  Force the runner name (claude/codex/grok/cursor)
#   FARMSLOT_POOL_DIR      Override pool directory

SLOT_ID="${1:?Usage: session-usage.sh <slot-id> <snapshot|report|total>}"
ACTION="${2:?Usage: session-usage.sh <slot-id> <snapshot|report|total>}"

FARMSLOT="$(cd "$(dirname "$0")/../packages/cli" && pwd)/bin/farmslot.mjs"
exec "$FARMSLOT" internal session-usage "$SLOT_ID" "$ACTION"
