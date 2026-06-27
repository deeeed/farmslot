import fs from 'node:fs';
import path from 'node:path';

import {
  assertPreMergeReview,
  hasPreMergeGhApprove,
  loadCrossReviewLoop,
  parseIsoMs,
  requiredChecksGreen,
} from './adr032-pr-chain-validate.mjs';

const PR81_EVIDENCE = [
  'pr81-premerge.json',
  'pr81-merge-timing-note.json',
  'pr81-CROSS-REVIEW-LOOP.json',
  'cross-review-pr81.txt',
  'GOAL-SCOPE.json',
];

function crossReviewTextApproves(text) {
  for (const line of text.split(/\r?\n/)) {
    if (/^VERDICT:\s*APPROVE pending CI\s*$/i.test(line)) return true;
    if (/^VERDICT:\s*APPROVE\s*$/i.test(line)) return true;
    if (/^VERDICT:/i.test(line)) return false;
  }
  return false;
}

function crossReviewLoopMatchesPr81(loop) {
  if (!loop?.task?.includes('PR #81')) return false;
  if (loop.finalVerdict !== 'clean' || loop.status !== 'clean' || loop.blockingFindingsOpen !== 0) {
    return false;
  }
  const last = loop.cycleRecords?.[loop.cycleRecords.length - 1];
  if (!last) return false;
  return (last.reviewerVerdicts ?? []).some((v) => v.verdict === 'PASS' && v.blockingCount === 0);
}

export function verifyPr81MergeProcess(evidenceDir, livePrView = null) {
  for (const file of PR81_EVIDENCE) {
    const p = path.join(evidenceDir, file);
    if (!fs.existsSync(p)) {
      return { ok: false, error: `missing ${file}` };
    }
  }

  const scope = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'GOAL-SCOPE.json'), 'utf8'));
  if (scope.goalCriteria2and3Pr !== 81) {
    return { ok: false, error: 'GOAL-SCOPE: expected goalCriteria2and3Pr 81' };
  }

  const timing = JSON.parse(
    fs.readFileSync(path.join(evidenceDir, 'pr81-merge-timing-note.json'), 'utf8'),
  );
  const premerge = JSON.parse(
    fs.readFileSync(path.join(evidenceDir, 'pr81-premerge.json'), 'utf8'),
  );
  const crossReviewText = fs.readFileSync(
    path.join(evidenceDir, 'cross-review-pr81.txt'),
    'utf8',
  );
  const loop = loadCrossReviewLoop(evidenceDir, 81);

  if (timing.pr !== 81) {
    return { ok: false, error: 'pr81-merge-timing-note: expected pr 81' };
  }
  if (timing.processWaiver) {
    return { ok: false, error: 'pr81-merge-timing-note: processWaiver not allowed' };
  }
  if (timing.mergeTimeCiGreen !== true) {
    return { ok: false, error: 'pr81-merge-timing-note: mergeTimeCiGreen must be true' };
  }

  const mergedAt = timing.mergedAt;
  const mergedMs = parseIsoMs(mergedAt);
  if (mergedMs == null) {
    return { ok: false, error: 'pr81-merge-timing-note: invalid mergedAt' };
  }

  if (premerge.number !== 81) {
    return { ok: false, error: 'pr81-premerge: expected number 81' };
  }
  if (premerge.state !== 'OPEN') {
    return { ok: false, error: `pr81-premerge: expected OPEN snapshot, got ${premerge.state}` };
  }

  const frozenCi = requiredChecksGreen(premerge.statusCheckRollup ?? [], mergedAt);
  if (!frozenCi.greenAtDecision) {
    return {
      ok: false,
      error: 'pr81-premerge: required CI not green at merge decision',
      inProgressJobs: frozenCi.inProgressJobs,
      notSuccessJobs: frozenCi.notSuccessJobs,
    };
  }
  if (!frozenCi.capturedBeforeMerge) {
    return { ok: false, error: 'pr81-premerge: required jobs not all completed before mergedAt' };
  }

  let liveCi = null;
  if (livePrView) {
    liveCi = requiredChecksGreen(livePrView.statusCheckRollup ?? [], mergedAt);
    if (!liveCi.greenAtDecision || !liveCi.capturedBeforeMerge) {
      return {
        ok: false,
        error: 'live gh pr view 81: required CI not green before mergedAt',
        liveCi,
      };
    }
  }

  if (!crossReviewTextApproves(crossReviewText)) {
    return { ok: false, error: 'cross-review-pr81.txt: missing anchored APPROVE verdict line' };
  }
  if (!crossReviewLoopMatchesPr81(loop)) {
    return { ok: false, error: 'pr81-CROSS-REVIEW-LOOP.json: missing clean PASS for PR #81' };
  }

  const review = assertPreMergeReview({ number: 81, mergedAt, reviews: [] }, evidenceDir);
  if (!review.ok) {
    return { ok: false, error: review.error, timing: review.timing };
  }
  if (review.timing !== 'pre-merge-cross-review') {
    return {
      ok: false,
      error: `PR #81: plan criterion 2 requires pre-merge cross-review for this merge; got ${review.timing}`,
    };
  }

  const ghPreMergeApprove =
    livePrView != null && hasPreMergeGhApprove({ ...livePrView, mergedAt });

  return {
    ok: true,
    pr: 81,
    mergedAt,
    mergeCommit: timing.mergeCommit,
    reviewTiming: review.timing,
    planCriterion2: 'cross-review-orchestrator equivalent (pr81-CROSS-REVIEW-LOOP.json)',
    planCriterion3: 'required CI SUCCESS on PR head before mergedAt (frozen + live gh rollup)',
    ghPreMergeApprove: ghPreMergeApprove === true,
    ghPreMergeApproveExpected: false,
    frozenCi,
    liveCi,
  };
}