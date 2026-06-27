#!/usr/bin/env bash
# ADR-032 Phase 1 + 1.5 closeout gate — live tmux E2E + install probes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="$ROOT/docs/operations/evidence"
TMP_REPO="$(mktemp -d "${TMPDIR:-/tmp}/adr032-gate-XXXXXX")"
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
    --slot-id "adr032-gate-${HOST}" \
    --repo "$TMP_REPO" \
    --runtime-dir ".agent" \
    --out "$out"
  echo "probe ${runner} -> $out"
}

echo "== ADR-032 Phase 1 empirical gate on ${HOST} =="

if [ "${ADR032_SKIP_E2E:-}" = "1" ]; then
  echo "== live tmux E2E (skipped — ADR032_SKIP_E2E=1) =="
else
  echo "== live tmux E2E (primary) =="
  bash "$ROOT/scripts/e2e-tmux-runner-validate.sh"
fi

echo "== observability install probes =="
run_probe claude
run_probe codex

echo "ADR-032 phase 1 gate complete"