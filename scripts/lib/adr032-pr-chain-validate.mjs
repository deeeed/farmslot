import fs from 'node:fs';
import path from 'node:path';

const MERGE_SKEW_MS = 120_000;

export function parseIsoMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function hasPreMergeGhApprove(pr) {
  const mergedMs = parseIsoMs(pr.mergedAt);
  if (mergedMs == null) return false;
  const author = pr.author?.login ?? null;
  return (pr.reviews ?? []).some((r) => {
    if (r.state !== 'APPROVED' || !r.author?.login || r.author.login === author) return false;
    const submittedMs = parseIsoMs(r.submittedAt);
    return submittedMs != null && submittedMs <= mergedMs;
  });
}

export function loadCrossReviewLoop(evidenceDir, prNumber) {
  const file = path.join(evidenceDir, `pr${prNumber}-CROSS-REVIEW-LOOP.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function hasPreMergeCrossReview(evidenceDir, pr, rootDir = evidenceDir) {
  const doc = loadCrossReviewLoop(rootDir, pr.number);
  if (!doc) return false;
  if (doc.finalVerdict !== 'clean' || doc.status !== 'clean' || doc.blockingFindingsOpen !== 0) {
    return false;
  }
  const mergedMs = parseIsoMs(pr.mergedAt);
  if (mergedMs == null) return false;
  const records = doc.cycleRecords ?? [];
  if (records.length === 0) return false;
  const last = records[records.length - 1];
  const completedMs = parseIsoMs(last.completedAt);
  if (completedMs == null) return false;
  const verdicts = last.reviewerVerdicts ?? [];
  const pass = verdicts.some((v) => v.verdict === 'PASS' && v.blockingCount === 0);
  return pass && completedMs <= mergedMs + MERGE_SKEW_MS;
}

export function reviewTimingForPr(pr, evidenceDir) {
  if (hasPreMergeGhApprove(pr)) return 'pre-merge-gh-approve';
  if (hasPreMergeCrossReview(evidenceDir, pr, evidenceDir)) return 'pre-merge-cross-review';
  const hasPostMergeGh = (pr.reviews ?? []).some((r) => r.state === 'APPROVED');
  if (hasPostMergeGh) return 'post-merge-gh-only';
  return 'no-independent-review';
}

export function assertPreMergeReview(pr, evidenceDir) {
  const timing = reviewTimingForPr(pr, evidenceDir);
  if (timing === 'pre-merge-gh-approve' || timing === 'pre-merge-cross-review') {
    return { ok: true, timing };
  }
  return {
    ok: false,
    timing,
    error: `PR ${pr.number}: requires pre-merge independent review (gh APPROVE before mergedAt or cross-review JSON completed before merge); got ${timing}`,
  };
}

export function requiredChecksGreen(checks, mergedAt) {
  const mergedMs = parseIsoMs(mergedAt);
  const required = [
    'Repository quality guards',
    'Command Center quality gates',
    'Docs quality gates',
    'Gateway service quality',
  ];
  const inProgress = (checks ?? []).filter(
    (c) => c.status === 'IN_PROGRESS' && required.includes(c.name),
  );
  const failed = (checks ?? []).filter(
    (c) => required.includes(c.name) && String(c.conclusion).toLowerCase() === 'failure',
  );
  return {
    greenAtDecision: inProgress.length === 0 && failed.length === 0,
    inProgressJobs: inProgress.map((c) => c.name),
    failedJobs: failed.map((c) => c.name),
    capturedBeforeMerge:
      mergedMs != null &&
      (checks ?? []).every((c) => {
        const doneMs = parseIsoMs(c.completedAt);
        return c.status !== 'IN_PROGRESS' || doneMs == null || doneMs <= mergedMs + MERGE_SKEW_MS;
      }),
  };
}