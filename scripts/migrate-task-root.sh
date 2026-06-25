#!/usr/bin/env bash
# migrate-task-root.sh — Wrapper for migrate-task-root.mjs
set -euo pipefail
FARMSLOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$FARMSLOT_DIR/scripts/migrate-task-root.mjs" "$@"