#!/usr/bin/env bash
# ADR-032 merge-process verifier (plan criteria 2, 3) for historical PR #81 only.
# Uses frozen evidence under docs/operations/evidence/adr032/ — not replay PR mislabels.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_MERGE_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032}}"

fail() {
  echo "MERGE-PROCESS FAIL: $*" >&2
  exit 1
}

echo "== verify ADR-032 merge process (PR #81 frozen evidence: ${EVIDENCE_DIR}) =="

POSTMERGE="$(mktemp)"
trap 'rm -f "$POSTMERGE"' EXIT

gh pr view 81 --json number,state,mergedAt,mergeCommit,url >"$POSTMERGE" || fail 'gh pr view 81'

(
  cd "$ROOT"
  node --input-type=module -e "
import fs from 'node:fs';
import { verifyPr81MergeProcess } from './scripts/lib/verify-adr032-pr81-merge-process.mjs';
import { parseIsoMs } from './scripts/lib/adr032-pr-chain-validate.mjs';

const evidenceDir = process.argv[1];
const postPath = process.argv[2];
const result = verifyPr81MergeProcess(evidenceDir);
if (!result.ok) {
  console.error(result.error ?? 'PR81 merge-process validation failed', result);
  process.exit(1);
}

const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
if (post.state !== 'MERGED') {
  console.error('gh pr view 81: expected MERGED, got', post.state);
  process.exit(1);
}
const liveMergedMs = parseIsoMs(post.mergedAt);
const frozenMergedMs = parseIsoMs(result.mergedAt);
if (liveMergedMs == null || frozenMergedMs == null || liveMergedMs !== frozenMergedMs) {
  console.error('gh pr view 81: mergedAt mismatch with frozen timing note', {
    live: post.mergedAt,
    frozen: result.mergedAt,
  });
  process.exit(1);
}

console.log('ok merge-process: PR #81 frozen pre-merge CI + pre-merge cross-review', {
  reviewTiming: result.reviewTiming,
  mergedAt: result.mergedAt,
  mergeCommit: result.mergeCommit,
});
" "$EVIDENCE_DIR" "$POSTMERGE"
) || fail 'PR #81 merge-process validation'

echo "MERGE-PROCESS PASS: PR #81 criteria 2-3 satisfied via frozen evidence + live MERGED state"