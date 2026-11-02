#!/usr/bin/env bash
# Nightly canary (canary.mts --profile nightly) on this host. launchd starts it (install-nightly.sh).
# It moves its checkout to origin/main, runs the isolated restart matrix, keeps the evidence, and
# overwrites one status line that the lead's watcher reads:
#
#   OK <utc> canary-nightly <sha> <summary> (<minutes>m) results=<file>
#   BLOCKED <utc> canary-nightly <sha> <summary> (<minutes>m) results=<file>
#
# BLOCKED covers a check that failed and a night the matrix could not run; KNOWN and NOT_EXERCISED
# show in the summary without blocking. Exit status is the canary's (0 ok, 1 failed, 2 could not run).
#
# Environment (defaults in parentheses):
#   CANARY_CHECKOUT      checkout to run (~/dev/farmslot-worktrees/canary-nightly)
#   CANARY_HOME          evidence and CLI snapshots (~/farmslot-canary)
#   CANARY_STATUS        status line (~/lanes/canary-nightly/STATUS.md)
#   CANARY_REF           ref of origin to run (main)
#   CANARY_NIGHTLY_ARGS  canary arguments (--with-review: the two codex gpt-6-luna reviews)
#   CANARY_KEEP_RUNS     evidence directories kept (14)
#   CANARY_WAIT_MIN      how long to wait for another proof job on this host (90)
set -uo pipefail

# Run from a copy: the checkout below moves to origin/main, which rewrites this file.
if [ -z "${CANARY_NIGHTLY_COPY:-}" ]; then
  copy="$(mktemp -t canary-nightly)"
  cp "$0" "$copy"
  CANARY_NIGHTLY_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$CANARY_NIGHTLY_COPY"' EXIT

CHECKOUT="${CANARY_CHECKOUT:-$HOME/dev/farmslot-worktrees/canary-nightly}"
CANARY_HOME="${CANARY_HOME:-$HOME/farmslot-canary}"
STATUS="${CANARY_STATUS:-$HOME/lanes/canary-nightly/STATUS.md}"
REF="${CANARY_REF:-main}"
ARGS="${CANARY_NIGHTLY_ARGS-"--with-review"}"
KEEP_RUNS="${CANARY_KEEP_RUNS:-14}"
WAIT_MIN="${CANARY_WAIT_MIN:-90}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$CANARY_HOME/runs/nightly-$STAMP"
START=$(date +%s)
mkdir -p "$OUT" "$(dirname "$STATUS")"
exec > >(tee -a "$OUT/nightly.log") 2>&1

# For a night that ends before the canary writes its own status line.
blocked() {
  local sha=$1 summary=$2
  local minutes=$(( ($(date +%s) - START + 59) / 60 ))
  printf 'BLOCKED %s canary-nightly %s %s (%sm) results=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%MZ)" "${sha:0:8}" "$summary" "$minutes" "$OUT/results.json" \
    > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  cat "$STATUS"
}

# One heavy job on this host at a time: wait for another lane's proof or test suite to finish.
deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
while pgrep -f 'proof\.mts|runner-validation/gateway/|runner-validation/canary/canary\.mts|run-tsx-tests' >/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    blocked - "could not run: another proof job held this host for ${WAIT_MIN}m"
    exit 2
  fi
  sleep 30
done

if ! git -C "$CHECKOUT" fetch -q origin "$REF" || ! git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD; then
  blocked - "could not run: fetching origin/$REF into $CHECKOUT failed"
  exit 2
fi
SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
cd "$CHECKOUT" || exit 2
# Install only when the lockfile changed since the last install.
lock="$(shasum yarn.lock | cut -d' ' -f1)"
if [ "$(cat node_modules/.canary-lock 2>/dev/null)" != "$lock" ]; then
  if ! nice -n 10 yarn install --immutable > "$OUT/yarn-install.log" 2>&1; then
    blocked "$SHA" "could not run: yarn install failed (see $OUT/yarn-install.log)"
    exit 2
  fi
  echo "$lock" > node_modules/.canary-lock
fi
# A node deployment has its runtime packages built; worker launch preflights import them.
if ! nice -n 10 yarn workspace @farmslot/agent-runtime build > "$OUT/build.log" 2>&1; then
  blocked "$SHA" "could not run: package build failed (see $OUT/build.log)"
  exit 2
fi

# shellcheck disable=SC2086 # ARGS is a list of flags
CANARY_STAMP="nightly-$STAMP" TSX_TSCONFIG_PATH="$CHECKOUT/services/gateway/tsconfig.json" \
  nice -n 10 node --import tsx scripts/runner-validation/canary/canary.mts --profile nightly $ARGS \
  --evidence "$OUT" --results "$OUT/results.json" --status-file "$STATUS" \
  --cli-snapshots "$CANARY_HOME/cli-snapshots"
code=$?
[ "$code" -ne 0 ] && [ ! -f "$OUT/results.json" ] && blocked "$SHA" "could not run: the canary exited $code without results"
ln -sfn "$OUT" "$CANARY_HOME/latest-nightly"

# Retention: the newest evidence directories, and the CLI snapshots of the last three nights.
ls -1dt "$CANARY_HOME"/runs/nightly-*/ 2>/dev/null | tail -n +"$((KEEP_RUNS + 1))" | while read -r dir; do rm -rf "$dir"; done
ls -1dt "$CANARY_HOME"/cli-snapshots/*/ 2>/dev/null | tail -n +4 | while read -r dir; do rm -rf "$dir"; done
exit "$code"
