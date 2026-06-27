#!/usr/bin/env bash
# ADR-032 Phase 2 exit gate: zero nudgeTimeoutCount over rolling window on Claude runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-${ADR032_PHASE2_EVIDENCE:-/tmp/adr032-phase2-exit.json}}"
WINDOW_DAYS="${ADR032_PHASE2_WINDOW_DAYS:-7}"
RUNS_DIR="${ADR032_RUNS_DIR:-$ROOT/.runs}"

node "$ROOT/scripts/capture-adr032-phase2-exit-evidence.mjs" \
  --runs-dir "$RUNS_DIR" \
  --window-days "$WINDOW_DAYS" \
  --runner claude \
  --out "$OUT"

RUNNER_RUNS="$(node -e "const r=require('${OUT}'); process.stdout.write(String(r.runnerRunsInWindow??0))")"
echo "PHASE2-EXIT PASS: nudgeTimeoutCount=0 over ${WINDOW_DAYS}d on Claude runs (${RUNNER_RUNS} runs)"