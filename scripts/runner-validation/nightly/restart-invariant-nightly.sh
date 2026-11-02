#!/usr/bin/env bash
# Nightly restart invariant (scripts/runner-validation/gateway/restart-invariant.mts) on this host.
# launchd starts it (install-restart-invariant.sh). It moves its checkout to origin/main, runs the
# matrix, keeps the evidence, and overwrites one status line that the lead's watcher reads:
#
#   PASS <utc> restart-invariant <sha> <summary> (<minutes>m) results=<file>
#   BLOCKED <utc> restart-invariant <sha> <summary> (<minutes>m) results=<file>
#
# BLOCKED covers a step that differs from its baseline and a night the matrix could not run.
# Exit status is the driver's (0 pass, 1 a step differed, 2 could not run).
#
# Environment (defaults in parentheses):
#   RI_CHECKOUT    checkout to run (~/dev/farmslot-worktrees/restart-invariant-nightly)
#   RI_HOME        evidence and CLI snapshots (~/farmslot-restart-invariant)
#   RI_STATUS      status line (~/lanes/restart-invariant/STATUS.md)
#   RI_KEEP_RUNS   evidence directories kept (14)
#   RI_WAIT_MIN    how long to wait for another proof job on this host (90)
set -uo pipefail

# Run from a copy: the checkout below moves to origin/main, which rewrites this file.
if [ -z "${RI_NIGHTLY_COPY:-}" ]; then
  copy="$(mktemp -t restart-invariant-nightly)"
  cp "$0" "$copy"
  RI_NIGHTLY_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$RI_NIGHTLY_COPY"' EXIT

CHECKOUT="${RI_CHECKOUT:-$HOME/dev/farmslot-worktrees/restart-invariant-nightly}"
RI_HOME="${RI_HOME:-$HOME/farmslot-restart-invariant}"
STATUS="${RI_STATUS:-$HOME/lanes/restart-invariant/STATUS.md}"
KEEP_RUNS="${RI_KEEP_RUNS:-14}"
WAIT_MIN="${RI_WAIT_MIN:-90}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$RI_HOME/runs/$STAMP"
START=$(date +%s)
mkdir -p "$OUT" "$(dirname "$STATUS")"
exec > >(tee -a "$OUT/nightly.log") 2>&1

status() {
  local verdict=$1 sha=$2 summary=$3
  local minutes=$(( ($(date +%s) - START + 59) / 60 ))
  printf '%s %s restart-invariant %s %s (%sm) results=%s\n' \
    "$verdict" "$(date -u +%Y-%m-%dT%H:%MZ)" "${sha:0:8}" "$summary" "$minutes" "$OUT/results.json" \
    > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  cat "$STATUS"
}

# One proof job on this host at a time: wait for another lane's proof to finish.
deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
while pgrep -f 'proof\.mts|runner-validation/gateway/' >/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    status BLOCKED - "could not run: another proof job held this host for ${WAIT_MIN}m"
    exit 2
  fi
  sleep 30
done

if ! git -C "$CHECKOUT" fetch -q origin main || ! git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD; then
  status BLOCKED - "could not run: fetching origin/main into $CHECKOUT failed"
  exit 2
fi
SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
cd "$CHECKOUT" || exit 2
# Install only when the lockfile changed since the last install.
lock="$(shasum yarn.lock | cut -d' ' -f1)"
if [ "$(cat node_modules/.restart-invariant-lock 2>/dev/null)" != "$lock" ]; then
  if ! nice -n 10 yarn install --immutable > "$OUT/yarn-install.log" 2>&1; then
    status BLOCKED "$SHA" "could not run: yarn install failed (see $OUT/yarn-install.log)"
    exit 2
  fi
  echo "$lock" > node_modules/.restart-invariant-lock
fi

RESTART_INVARIANT_STAMP="nightly-$STAMP" TSX_TSCONFIG_PATH="$CHECKOUT/services/gateway/tsconfig.json" \
  nice -n 10 node --import tsx scripts/runner-validation/gateway/restart-invariant.mts \
  --evidence "$OUT" --results "$OUT/results.json" --cli-snapshots "$RI_HOME/cli-snapshots"
code=$?

summary="$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(r.summary)' "$OUT/results.json" 2>/dev/null)"
if [ "$code" -eq 0 ]; then
  status PASS "$SHA" "$summary"
else
  status BLOCKED "$SHA" "${summary:-could not run: driver exited $code without results} (exit $code)"
fi
ln -sfn "$OUT" "$RI_HOME/latest"

# Retention: the newest evidence directories, and the CLI snapshots of the last three nights.
ls -1dt "$RI_HOME"/runs/*/ 2>/dev/null | tail -n +"$((KEEP_RUNS + 1))" | while read -r dir; do rm -rf "$dir"; done
ls -1dt "$RI_HOME"/cli-snapshots/*/ 2>/dev/null | tail -n +4 | while read -r dir; do rm -rf "$dir"; done
exit "$code"
