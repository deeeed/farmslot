#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node --import tsx --test "$root/tests/pane-state.test.mjs"
