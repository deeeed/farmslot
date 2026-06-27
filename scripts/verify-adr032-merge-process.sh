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

node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';

const evidenceDir = process.argv[1];
const pre = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr81-premerge-capture.json'), 'utf8'));
const post = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'pr81-postmerge.json'), 'utf8'));
const crossReview = fs.readFileSync(path.join(evidenceDir, 'cross-review-pr81.txt'), 'utf8');

if (!pre.capturedAt) {
  console.error('pr81-premerge-capture: missing capturedAt');
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

const author = pre.prView?.author?.login ?? pre.author ?? null;
const mergedAt = post.mergedAt ?? post.prView?.mergedAt;
if (!mergedAt) {
  console.error('pr81-postmerge: missing mergedAt');
  process.exit(1);
}
const mergedMs = Date.parse(mergedAt);
const captureMs = Date.parse(pre.capturedAt);
if (!(captureMs < mergedMs)) {
  console.error('pr81: capturedAt must precede mergedAt');
  process.exit(1);
}

const approve = (pre.prView?.reviews ?? []).find(
  (r) => r.state === 'APPROVED' && r.author?.login && r.author.login !== author,
);
if (!approve?.submittedAt) {
  console.error('pr81-premerge-capture: no independent APPROVED review payload');
  process.exit(1);
}
if (Date.parse(approve.submittedAt) > mergedMs) {
  console.error('pr81: APPROVED submittedAt after mergedAt');
  process.exit(1);
}

if (!/VERDICT:\s*APPROVE/i.test(crossReview) && !/APPROVE pending CI/i.test(crossReview)) {
  console.error('cross-review-pr81.txt: missing APPROVE verdict');
  process.exit(1);
}

if (post.state !== 'MERGED' && post.prView?.state !== 'MERGED') {
  console.error('pr81-postmerge: expected MERGED');
  process.exit(1);
}

console.log('ok merge-process: PR81 frozen pre/post + cross-review satisfied');
" "$EVIDENCE_DIR" || fail 'PR81 merge-process validation'

echo "MERGE-PROCESS PASS: frozen PR #81 evidence satisfies criteria 2-3"