#!/usr/bin/env bash
# ADR-032 goal closeout: shipped code (criteria 1,4,5) + PR #81 merge-process (criteria 2,3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-${ADR032_EVIDENCE_DIR:-${SCRATCH:-/tmp}/adr032-shipped}}"

echo "== ADR-032 goal evidence (split verifiers) =="
bash "$ROOT/scripts/verify-adr032-no-invalid-paths.sh"

SCRATCH="${SCRATCH:-$(dirname "$OUT_DIR")}" ADR032_SHIPPED_EVIDENCE_DIR="$OUT_DIR" \
  bash "$ROOT/scripts/verify-adr032-shipped-main.sh" "$OUT_DIR"

ADR032_MERGE_EVIDENCE_DIR="${ADR032_MERGE_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}" \
  bash "$ROOT/scripts/verify-adr032-merge-process.sh" \
  "$ROOT/docs/operations/evidence/adr032"

echo "ASSERT PASS: shipped-main + PR #81 merge-process satisfied"