#!/usr/bin/env bash
# Atomic pre-merge snapshot. Run immediately before gh pr merge.
# Exits non-zero unless independent APPROVED review exists and required CI is SUCCESS.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: capture-pre-merge-evidence.sh <pr-number> <output.json>" >&2
  exit 1
fi

PR_NUM="$1"
OUT_PATH="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PR_VIEW="$(mktemp)"
RUNS="$(mktemp)"
trap 'rm -f "$PR_VIEW" "$RUNS"' EXIT

gh pr view "$PR_NUM" \
  --json number,title,state,author,headRefOid,mergeStateStatus,reviews,statusCheckRollup,url \
  >"$PR_VIEW"

HEAD_SHA="$(node --input-type=module -e "
import fs from 'node:fs';
const pr = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
process.stdout.write(pr.headRefOid ?? '');
" "$PR_VIEW")"

if [[ -z "$HEAD_SHA" ]]; then
  echo "capture-pre-merge: missing headRefOid for PR #${PR_NUM}" >&2
  exit 1
fi

gh run list --commit "$HEAD_SHA" --limit 30 \
  --json databaseId,name,status,conclusion,event,headSha,createdAt \
  >"$RUNS"

(
  cd "$ROOT"
  node --input-type=module -e "
import fs from 'node:fs';
import {
  independentApproveOnHead,
  requiredChecksGreen,
} from './scripts/lib/adr032-pr-chain-validate.mjs';

const pr = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const runs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];

const author = pr.author?.login ?? null;
const approveOnHead = independentApproveOnHead(pr);
const hasIndependentApprove = approveOnHead != null;
const checks = requiredChecksGreen(pr.statusCheckRollup ?? [], null);

const qualityRun = runs.find((r) => r.name === 'Farmslot Quality');
const doc = {
  capturedAt: new Date().toISOString(),
  pr: pr.number,
  headRefOid: pr.headRefOid,
  mergeStateStatus: pr.mergeStateStatus,
  author,
  hasIndependentApprove,
  independentApproveOnHead: approveOnHead,
  requiredChecksGreen: checks.greenAtDecision,
  inProgressJobs: checks.inProgressJobs,
  notSuccessJobs: checks.notSuccessJobs,
  farmslotQualityRun: qualityRun ?? null,
  prView: pr,
  workflowRuns: runs,
};

fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\\n');

if (!hasIndependentApprove) {
  console.error('capture-pre-merge: missing independent APPROVED review on PR', pr.number);
  process.exit(1);
}
if (!doc.requiredChecksGreen) {
  console.error('capture-pre-merge: required CI not SUCCESS', {
    inProgress: doc.inProgressJobs,
    notSuccess: doc.notSuccessJobs,
  });
  process.exit(1);
}
console.log('ok capture-pre-merge: PR', pr.number, 'ready for merge');
" "$PR_VIEW" "$RUNS" "$OUT_PATH"
)