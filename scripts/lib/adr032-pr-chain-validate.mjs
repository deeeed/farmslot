import fs from 'node:fs';
import path from 'node:path';

/** Allow cross-review completion slightly before merge when clocks skew. */
const PRE_MERGE_SKEW_MS = 120_000;

export function parseIsoMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function independentApproveOnHead(pr) {
  const head = pr.headRefOid ?? null;
  const author = pr.author?.login ?? null;
  if (!head) return null;
  return (pr.reviews ?? []).find((r) => {
    if (r.state !== 'APPROVED' || !r.author?.login || r.author.login === author) return false;
    return r.commit?.oid === head;
  }) ?? null;
}

export function hasPreMergeGhApprove(pr) {
  const mergedMs = parseIsoMs(pr.mergedAt);
  if (mergedMs == null) return false;
  const approve = independentApproveOnHead(pr);
  if (!approve) return false;
  const submittedMs = parseIsoMs(approve.submittedAt);
  return submittedMs != null && submittedMs <= mergedMs;
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
  return pass && completedMs <= mergedMs && completedMs >= mergedMs - PRE_MERGE_SKEW_MS;
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
  const requiredChecks = (checks ?? []).filter((c) => required.includes(c.name));
  const inProgress = requiredChecks.filter(
    (c) => c.status === 'IN_PROGRESS' || c.status === 'PENDING' || c.status === 'QUEUED',
  );
  const notSuccess = requiredChecks.filter((c) => {
    const conclusion = String(c.conclusion ?? '').toLowerCase();
    if (inProgress.includes(c)) return false;
    if (c.status !== 'COMPLETED') return true;
    return conclusion !== 'success' && conclusion !== 'skipped';
  });
  return {
    greenAtDecision: requiredChecks.length === required.length && inProgress.length === 0 && notSuccess.length === 0,
    inProgressJobs: inProgress.map((c) => c.name),
    notSuccessJobs: notSuccess.map((c) => c.name),
    capturedBeforeMerge:
      mergedMs != null &&
      requiredChecks.every((c) => {
        const doneMs = parseIsoMs(c.completedAt);
        return c.status === 'COMPLETED' && doneMs != null && doneMs <= mergedMs;
      }),
  };
}