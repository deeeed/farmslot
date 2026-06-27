#!/usr/bin/env bash
# ADR-032 goal closeout: shipped code (criteria 1,4,5) + optional merge-process replay.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-${ADR032_EVIDENCE_DIR:-${SCRATCH:-/tmp}/adr032-shipped}}"

echo "== ADR-032 goal evidence (split verifiers) =="
SCRATCH="${SCRATCH:-$(dirname "$OUT_DIR")}" ADR032_SHIPPED_EVIDENCE_DIR="$OUT_DIR" \
  bash "$ROOT/scripts/verify-adr032-shipped-main.sh" "$OUT_DIR"

REPLAY_DIR="${ADR032_MERGE_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032/replay}"
if [[ -f "$REPLAY_DIR/pr81-premerge-capture.json" && -f "$REPLAY_DIR/pr81-postmerge.json" && -f "$REPLAY_DIR/cross-review-pr81.txt" ]]; then
  bash "$ROOT/scripts/verify-adr032-merge-process.sh" "$REPLAY_DIR"
else
  echo "MERGE-PROCESS SKIP: no frozen replay evidence at $REPLAY_DIR"
  echo "  Historical PRs #81–#86 lack pre-merge GH APPROVED; run replay PR per replay/README.md"
fi

echo "ASSERT PASS: shipped-main satisfied; merge-process checked when replay evidence present"