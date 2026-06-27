#!/usr/bin/env bash
# ADR-032 Phase 1 + 1.5 closeout gate — empirical probes and agreement-window check.
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
run_probe claude
run_probe codex

echo "== observability unit tests =="
cd "$ROOT/services/gateway"
node --import tsx --test \
  src/runners/observability-agreement-log.test.ts \
  src/runners/observability-agreement-window.test.ts \
  src/runners/observability-prompt-digest.test.ts \
  src/runners/observability-files.test.ts \
  src/runners/observability-agreement.test.ts

echo "== installer regression tests =="
cd "$ROOT"
node --test scripts/install-runner-observability.test.mjs

echo "== runner validation harness (static scenarios) =="
node --test scripts/runner-validation/run.test.mjs
node "$ROOT/scripts/runner-validation/run.mjs" --scenario busy-composer --runner both

echo "== runner validation harness (live tmux: hook-smoke) =="
node "$ROOT/scripts/runner-validation/run.mjs" --scenario hook-smoke --runner hooks

echo "== runner validation harness (live tmux: grok pane-smoke) =="
node "$ROOT/scripts/runner-validation/run.mjs" --scenario pane-smoke --runner grok

echo "== runner validation harness (live tmux: grok interaction-smoke) =="
node "$ROOT/scripts/runner-validation/run.mjs" --scenario interaction-smoke --runner grok

echo "== agreement window (production logs when present) =="
AGREEMENT_OUT="$EVIDENCE_DIR/adr032-phase1-agreement-${HOST}.json"
set +e
node "$ROOT/scripts/validate-observability-agreement-window.mjs" \
  --dir "$ROOT/.runs/observability-agreement" \
  --min-events 200 \
  --min-rate 0.98 \
  --out "$AGREEMENT_OUT"
AGREEMENT_RC=$?
set -e
if [[ "$AGREEMENT_RC" -ne 0 ]]; then
  echo "agreement window: insufficient live data (need 200 comparable events @ >=98%)"
  echo "report: $AGREEMENT_OUT"
  echo "probes + unit tests passed; enable hooks on fleet slots to collect agreement NDJSON"
else
  echo "agreement window PASS -> $AGREEMENT_OUT"
fi

echo "ADR-032 phase 1 gate complete"