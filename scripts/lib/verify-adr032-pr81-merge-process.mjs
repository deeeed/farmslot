import fs from 'node:fs';
import path from 'node:path';

import {
  assertPreMergeReview,
  parseIsoMs,
  requiredChecksGreen,
} from './adr032-pr-chain-validate.mjs';

const PR81_EVIDENCE = [
  'pr81-premerge.json',
  'pr81-merge-timing-note.json',
  'pr81-CROSS-REVIEW-LOOP.json',
];

export function verifyPr81MergeProcess(evidenceDir) {
  for (const file of PR81_EVIDENCE) {
    const p = path.join(evidenceDir, file);
    if (!fs.existsSync(p)) {
      return { ok: false, error: `missing ${file}` };
    }
  }

  const timing = JSON.parse(
    fs.readFileSync(path.join(evidenceDir, 'pr81-merge-timing-note.json'), 'utf8'),
  );
  const premerge = JSON.parse(
    fs.readFileSync(path.join(evidenceDir, 'pr81-premerge.json'), 'utf8'),
  );

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

  const ci = requiredChecksGreen(premerge.statusCheckRollup ?? [], mergedAt);
  if (!ci.greenAtDecision) {
    return {
      ok: false,
      error: 'pr81-premerge: required CI not green at merge decision',
      inProgressJobs: ci.inProgressJobs,
      notSuccessJobs: ci.notSuccessJobs,
    };
  }
  if (!ci.capturedBeforeMerge) {
    return { ok: false, error: 'pr81-premerge: required jobs not all completed before mergedAt' };
  }

  const review = assertPreMergeReview({ number: 81, mergedAt, reviews: [] }, evidenceDir);
  if (!review.ok) {
    return { ok: false, error: review.error, timing: review.timing };
  }

  return {
    ok: true,
    pr: 81,
    mergedAt,
    mergeCommit: timing.mergeCommit,
    reviewTiming: review.timing,
    ci,
  };
}