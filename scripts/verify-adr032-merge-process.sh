#!/usr/bin/env bash
# ADR-032 merge-process verifier (plan criteria 2, 3). Strict: frozen pre-merge JSON only.
# No LOOP-timing proxy, no processWaiver, no post-harvest gh pr view.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${1:-${ADR032_MERGE_EVIDENCE_DIR:-$ROOT/docs/operations/evidence/adr032/replay}}"

fail() {
  echo "MERGE-PROCESS FAIL: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

echo "== verify ADR-032 merge process (frozen evidence: ${EVIDENCE_DIR}) =="

require_file "$EVIDENCE_DIR/pr81-premerge-capture.json"
require_file "$EVIDENCE_DIR/pr81-postmerge.json"
require_file "$EVIDENCE_DIR/cross-review-pr81.txt"

(
  cd "$ROOT"
  node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';
import {
  independentApproveOnHead,
  parseIsoMs,
} from './scripts/lib/adr032-pr-chain-validate.mjs';

function crossReviewApproves(text) {
  for (const line of text.split(/\\r?\\n/)) {
    if (/^VERDICT:\\s*APPROVE pending CI\\s*$/i.test(line)) return true;
    if (/^VERDICT:\\s*APPROVE\\s*$/i.test(line)) return true;
    if (/^VERDICT:/i.test(line)) return false;
  }
  return false;
}

const evidenceDir = process.argv[1];
const pre = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr81-premerge-capture.json'), 'utf8'));
const post = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr81-postmerge.json'), 'utf8'));
const crossReview = fs.readFileSync(path.join(evidenceDir, 'cross-review-pr81.txt'), 'utf8');

const captureMs = parseIsoMs(pre.capturedAt);
if (captureMs == null) {
  console.error('pr81-premerge-capture: invalid capturedAt', pre.capturedAt);
  process.exit(1);
}
if (pre.prView?.state !== 'OPEN') {
  console.error('pr81-premerge-capture: expected OPEN state at capture, got', pre.prView?.state);
  process.exit(1);
}
if (!pre.hasIndependentApprove) {
  console.error('pr81-premerge-capture: missing independent APPROVED at capture time');
  process.exit(1);
}
if (!pre.requiredChecksGreen) {
  console.error('pr81-premerge-capture: required CI not green at capture', pre);
  process.exit(1);
}

const prView = pre.prView ?? pre;
const approve = independentApproveOnHead(prView);
if (!approve?.submittedAt) {
  console.error('pr81-premerge-capture: no independent APPROVED review on headRefOid');
  process.exit(1);
}

const mergedAt = post.mergedAt ?? post.prView?.mergedAt;
const mergedMs = parseIsoMs(mergedAt);
if (mergedMs == null) {
  console.error('pr81-postmerge: invalid mergedAt', mergedAt);
  process.exit(1);
}
if (!(captureMs < mergedMs)) {
  console.error('pr81: capturedAt must precede mergedAt');
  process.exit(1);
}

const approveMs = parseIsoMs(approve.submittedAt);
if (approveMs == null) {
  console.error('pr81-premerge-capture: invalid APPROVED submittedAt', approve.submittedAt);
  process.exit(1);
}
if (approveMs > mergedMs) {
  console.error('pr81: APPROVED submittedAt after mergedAt');
  process.exit(1);
}

if (!crossReviewApproves(crossReview)) {
  console.error('cross-review-pr81.txt: missing APPROVE verdict line');
  process.exit(1);
}

if (post.state !== 'MERGED' && post.prView?.state !== 'MERGED') {
  console.error('pr81-postmerge: expected MERGED');
  process.exit(1);
}

console.log('ok merge-process: PR81 frozen pre/post + cross-review satisfied');
" "$EVIDENCE_DIR"
) || fail 'PR81 merge-process validation'

echo "MERGE-PROCESS PASS: frozen PR #81 evidence satisfies criteria 2-3"