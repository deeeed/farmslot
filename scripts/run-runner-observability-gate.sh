#!/usr/bin/env bash
# Runner observability empirical gate — live tmux E2E + install probes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="$ROOT/docs/operations/evidence"
TMP_REPO="$(mktemp -d "${TMPDIR:-/tmp}/runner-obs-gate-XXXXXX")"
HOST="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"

cleanup() {
  rm -rf "$TMP_REPO"
}
trap cleanup EXIT

mkdir -p "$EVIDENCE_DIR"

run_probe() {
  local runner="$1"
  local out="$EVIDENCE_DIR/adr032-phase1-probe-${HOST}-${runner}.json"
  node "$ROOT/scripts/probe-runner-observability.mjs" \
    --runner "$runner" \
    --slot-id "runner-obs-gate-${HOST}" \
    --repo "$TMP_REPO" \
    --runtime-dir ".agent" \
    --out "$out"
  echo "probe ${runner} -> $out"
}

echo "== runner observability empirical gate on ${HOST} =="

if [ "${RUNNER_OBS_SKIP_E2E:-${ADR032_SKIP_E2E:-}}" = "1" ]; then
  echo "== live tmux E2E (skipped — RUNNER_OBS_SKIP_E2E=1) =="
else
  echo "== live tmux E2E (primary) =="
  bash "$ROOT/scripts/e2e-tmux-runner-validate.sh"
fi

echo "== observability install probes =="
run_probe claude
run_probe codex

echo "runner observability gate complete"