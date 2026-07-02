#!/usr/bin/env bash
# run-shell-tests.sh — run every scripts/tests/*.test.sh against the real repo
# scripts. Dependency-free: plain bash, mktemp sandboxes inside each test.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
status=0
ran=0
for t in "$TESTS_DIR"/*.test.sh; do
  [ -e "$t" ] || continue
  ran=$((ran + 1))
  echo "[shell-test] $(basename "$t")"
  if bash "$t"; then
    echo "[shell-test] PASS $(basename "$t")"
  else
    echo "[shell-test] FAIL $(basename "$t")" >&2
    status=1
  fi
done
if [ "$ran" -eq 0 ]; then
  echo "[shell-test] no *.test.sh files found in $TESTS_DIR" >&2
  exit 1
fi
exit "$status"
