#!/usr/bin/env bash
# ADR-032 merge-process verifier (plan criteria 2, 3) for PR #81 only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_MERGE_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}}"

fail() {
  echo "MERGE-PROCESS FAIL: $*" >&2
  exit 1
}

echo "== verify ADR-032 merge process (PR #81: ${EVIDENCE_DIR}) =="

LIVE_PR="$(mktemp)"
trap 'rm -f "$LIVE_PR"' EXIT

gh pr view 81 \
  --json number,state,mergedAt,mergeCommit,url,statusCheckRollup,reviews,headRefOid \
  >"$LIVE_PR" || fail 'gh pr view 81'

(
  cd "$ROOT"
  node --input-type=module -e "
import fs from 'node:fs';
import { verifyPr81MergeProcess } from './scripts/lib/verify-adr032-pr81-merge-process.mjs';
import { parseIsoMs } from './scripts/lib/adr032-pr-chain-validate.mjs';

const evidenceDir = process.argv[1];
const livePath = process.argv[2];
const livePrView = JSON.parse(fs.readFileSync(livePath, 'utf8'));
const result = verifyPr81MergeProcess(evidenceDir, livePrView);
if (!result.ok) {
  console.error(result.error ?? 'PR81 merge-process validation failed', result);
  process.exit(1);
}

if (livePrView.state !== 'MERGED') {
  console.error('gh pr view 81: expected MERGED, got', livePrView.state);
  process.exit(1);
}
const liveMergedMs = parseIsoMs(livePrView.mergedAt);
const frozenMergedMs = parseIsoMs(result.mergedAt);
if (liveMergedMs == null || frozenMergedMs == null || liveMergedMs !== frozenMergedMs) {
  console.error('gh pr view 81: mergedAt mismatch with frozen timing note', {
    live: livePrView.mergedAt,
    frozen: result.mergedAt,
  });
  process.exit(1);
}

console.log('ok merge-process: PR #81 plan criteria 2-3', result);
" "$EVIDENCE_DIR" "$LIVE_PR"
) || fail 'PR #81 merge-process validation'

echo "MERGE-PROCESS PASS: PR #81 criteria 2-3 (cross-review + CI green before merge)"