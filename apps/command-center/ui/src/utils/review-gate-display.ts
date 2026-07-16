import type {
  ArtifactRef,
  GateSummary,
  IndependentReviewAttempt,
  IndependentReviewStatus,
  ReadyGatePayload,
  ReviewDepthPolicy,
} from '@farmslot/protocol';

export type ReviewFreshnessReason =
  | 'fresh'
  | 'unresolved-findings'
  | 'review-not-passing'
  | 'review-pending'
  | 'reviewed-head-missing'
  | 'reviewed-old-head'
  | 'package-review-subject-missing'
  | 'review-subject-missing'
  | 'review-subject-changed'
  | 'review-snapshot-unavailable';

export interface ReviewFreshnessDisplay {
  review: IndependentReviewStatus;
  reason: ReviewFreshnessReason;
  label: string;
  detail: string;
  stale: boolean;
  passing: boolean;
}

export interface ReviewGateCountSummary {
  requiredReviews: number;
  minimumReviews: number;
  extraReviewsRequested: number;
  externalRequired: boolean;
  totalReviews: number;
  totalAttempts: number;
  passingReviews: number;
  freshPassingReviews: number;
  trustedPassingReviews: number;
  staleIgnoredReviews: number;
  fixLoopCertified: boolean;
  unresolvedFindings: number;
  externalFreshPassingReviews: number;
  fullLiveFreshPassingReviews: number;
  freshness: ReviewFreshnessDisplay[];
}

export interface PublishEvidenceDisplayRow {
  path: string;
  purpose: string;
  included: boolean;
  dropped: boolean;
  label: string;
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : 'unknown';
}

export function normalizedReviewDepth(payload: ReadyGatePayload): ReviewDepthPolicy {
  const policy = payload.prPackage?.reviewDepth ?? payload.reviewDepth;
  const externalRequired = policy?.requireCrossRunner === true;
  const minimumReviews = Math.max(
    externalRequired ? 1 : 0,
    Math.max(0, policy?.minimumIndependentReviews ?? 1),
  );
  return {
    minimumIndependentReviews: minimumReviews,
    requireCrossRunner: externalRequired,
    extraLoopsRequested: Math.max(0, policy?.extraLoopsRequested ?? 0),
    requestedBy: policy?.requestedBy ?? 'dispatch',
  };
}

export function effectiveReviewRequirement(policy: ReviewDepthPolicy): number {
  return (
    Math.max(policy.requireCrossRunner ? 1 : 0, Math.max(0, policy.minimumIndependentReviews)) +
    Math.max(0, policy.extraLoopsRequested)
  );
}

export function reviewSourceLabel(
  review: Pick<IndependentReviewStatus, 'source' | 'crossRunner'>,
): string {
  // Every automated review pass is an Independent review; runner diversity is
  // gate policy metadata (reviewPolicyLabel), not a separate review kind.
  if (review.source === 'self-review') return 'Self-review';
  if (review.source === 'human-gate') return 'Independent review (requested)';
  return 'Independent review';
}

/**
 * Policy metadata for a review: runner diversity rendered as `runner: <id>`
 * when the reviewer runner is known, else the generic policy name. Null when
 * no diversity requirement applies.
 */
export function reviewPolicyLabel(
  review: Pick<IndependentReviewStatus, 'crossRunner'> & { runner?: string | null },
): string | null {
  if (!review.crossRunner) return null;
  return review.runner ? `runner: ${review.runner}` : 'runner diversity';
}

export function reviewAttemptLabel(
  review: IndependentReviewStatus,
  attemptIndex: number,
  attemptCount: number,
): string {
  const suffix = attemptCount > 1 ? ` ${attemptIndex + 1}/${attemptCount}` : '';
  return `${reviewSourceLabel(review)} attempt${suffix}`;
}

export function reviewSegmentLabel(
  review: Pick<IndependentReviewStatus, 'source' | 'crossRunner'>,
  order: number,
): string {
  return `${reviewSourceLabel(review)} ${order}`;
}

function reviewIsPassing(review: IndependentReviewStatus): boolean {
  return review.verdict === 'pass' && review.unresolvedCount === 0;
}

function reviewHead(review: IndependentReviewStatus): string | null | undefined {
  return review.reviewedHeadSha ?? review.reviewSnapshot?.headSha;
}

function reviewHasWorkerFixLoop(review: IndependentReviewStatus): boolean {
  if (review.feedbackSent) return true;
  if (review.timeline?.some((segment) => segment.kind === 'worker-fix')) return true;
  const attempts = review.attempts ?? [];
  if (attempts.some((attempt) => Boolean(attempt.fixDelta))) return true;
  const sawIssues = attempts.some(
    (attempt) => attempt.verdict === 'issues' && attempt.unresolvedCount > 0,
  );
  const sawPass = attempts.some(
    (attempt) => attempt.verdict === 'pass' && attempt.unresolvedCount === 0,
  );
  return sawIssues && sawPass;
}

function reviewCertifiesPreparedPackage(
  review: IndependentReviewStatus,
  payload: ReadyGatePayload,
): boolean {
  if (!reviewIsPassing(review)) return false;
  const packageHead = payload.prPackage?.headSha ?? payload.headSha;
  const packageSubject = payload.prPackage?.reviewSubjectHash?.trim();
  if (!packageHead || !packageSubject) return false;
  const reviewedHead = reviewHead(review);
  if (!reviewedHead || reviewedHead !== packageHead) return false;
  if (!review.reviewedHeadSha && review.reviewSnapshot?.source === 'unavailable') return false;
  return review.reviewedReviewSubjectHash === packageSubject;
}

function reviewCertifiesApprovedHeadAfterFix(
  review: IndependentReviewStatus,
  payload: ReadyGatePayload,
  requireCrossRunner: boolean,
): boolean {
  if (!reviewIsPassing(review)) return false;
  if (requireCrossRunner && !review.crossRunner) return false;
  if ((review.validationDepth ?? 'full-live') !== 'full-live') return false;
  const packageHead = payload.prPackage?.headSha ?? payload.headSha;
  const packageSubject = payload.prPackage?.reviewSubjectHash?.trim();
  const snapshot = review.reviewSnapshot;
  if (!packageHead || !packageSubject || !snapshot || snapshot.source === 'unavailable')
    return false;
  if (snapshot.headSha !== packageHead) return false;
  if (review.reviewedReviewSubjectHash !== packageSubject) return false;
  return reviewHasWorkerFixLoop(review);
}

export function classifyReviewFreshness(
  review: IndependentReviewStatus,
  payload: ReadyGatePayload,
): ReviewFreshnessDisplay {
  const sourceLabel = reviewSourceLabel(review);
  const passing = reviewIsPassing(review);
  if (review.unresolvedCount > 0) {
    return {
      review,
      reason: 'unresolved-findings',
      label: `${sourceLabel} has unresolved findings`,
      detail: `${review.unresolvedCount} unresolved finding${review.unresolvedCount === 1 ? '' : 's'}`,
      stale: false,
      passing,
    };
  }
  if (review.verdict === 'pending') {
    return {
      review,
      reason: 'review-pending',
      label: `${sourceLabel} still running`,
      detail: 'Review has not produced a passing verdict yet',
      stale: false,
      passing,
    };
  }
  if (!passing) {
    return {
      review,
      reason: 'review-not-passing',
      label: `${sourceLabel} is not passing`,
      detail: `Verdict is ${review.verdict}`,
      stale: false,
      passing,
    };
  }

  const packageHead = payload.prPackage?.headSha ?? payload.headSha;
  const packageSubject = payload.prPackage?.reviewSubjectHash?.trim();
  const reviewedHead = reviewHead(review);
  const reviewedSubject = review.reviewedReviewSubjectHash;
  if (!review.reviewedHeadSha && review.reviewSnapshot?.source === 'unavailable') {
    return {
      review,
      reason: 'review-snapshot-unavailable',
      label: `${sourceLabel} snapshot unavailable`,
      detail: review.reviewSnapshot.missingReason
        ? `Review snapshot unavailable (${review.reviewSnapshot.missingReason})`
        : 'Review snapshot unavailable',
      stale: true,
      passing,
    };
  }
  if (packageHead && !reviewedHead) {
    return {
      review,
      reason: 'reviewed-head-missing',
      label: `${sourceLabel} did not record reviewed HEAD`,
      detail: `Package HEAD is ${shortSha(packageHead)} but the review has no reviewed HEAD`,
      stale: true,
      passing,
    };
  }
  if (packageHead && reviewedHead !== packageHead) {
    return {
      review,
      reason: 'reviewed-old-head',
      label: `${sourceLabel} reviewed old HEAD`,
      detail: `Reviewed ${shortSha(reviewedHead)}; package HEAD is ${shortSha(packageHead)}`,
      stale: true,
      passing,
    };
  }
  if (!packageSubject) {
    return {
      review,
      reason: 'package-review-subject-missing',
      label: 'Package review subject unavailable',
      detail:
        'Prepared package does not expose a review-subject hash, so reviews cannot certify it',
      stale: true,
      passing,
    };
  }
  if (!reviewedSubject) {
    return {
      review,
      reason: 'review-subject-missing',
      label: `${sourceLabel} did not record package subject`,
      detail: 'Review did not record the package review-subject hash',
      stale: true,
      passing,
    };
  }
  if (reviewedSubject !== packageSubject) {
    return {
      review,
      reason: 'review-subject-changed',
      label: `${sourceLabel} reviewed old package subject`,
      detail: `Reviewed subject ${shortSha(reviewedSubject)}; package subject is ${shortSha(packageSubject)}`,
      stale: true,
      passing,
    };
  }
  return {
    review,
    reason: 'fresh',
    label: `${sourceLabel} fresh`,
    detail: packageHead
      ? `Reviewed package HEAD ${shortSha(packageHead)}`
      : 'Review matches package facts',
    stale: false,
    passing,
  };
}

export function summarizeReviewCounts(payload: ReadyGatePayload): ReviewGateCountSummary {
  const reviews = payload.independentReviews ?? [];
  const reviewDepth = normalizedReviewDepth(payload);
  const freshness = reviews.map((review) => classifyReviewFreshness(review, payload));
  const freshPassing = reviews.filter((review) => reviewCertifiesPreparedPackage(review, payload));
  const passingReviews = reviews.filter(reviewIsPassing);
  const fixLoopCertified = reviews.some((review) =>
    reviewCertifiesApprovedHeadAfterFix(review, payload, reviewDepth.requireCrossRunner),
  );
  return {
    requiredReviews: effectiveReviewRequirement(reviewDepth),
    minimumReviews: reviewDepth.minimumIndependentReviews,
    extraReviewsRequested: reviewDepth.extraLoopsRequested,
    externalRequired: reviewDepth.requireCrossRunner,
    totalReviews: reviews.length,
    totalAttempts: reviews.reduce(
      (sum, review) => sum + Math.max(1, review.attempts?.length ?? 0),
      0,
    ),
    passingReviews: passingReviews.length,
    freshPassingReviews: freshPassing.length,
    trustedPassingReviews: fixLoopCertified ? passingReviews.length : freshPassing.length,
    staleIgnoredReviews: fixLoopCertified ? 0 : freshness.filter((entry) => entry.stale).length,
    fixLoopCertified,
    unresolvedFindings: reviews.reduce((sum, review) => sum + review.unresolvedCount, 0),
    externalFreshPassingReviews: (fixLoopCertified ? passingReviews : freshPassing).filter(
      (review) => review.crossRunner,
    ).length,
    fullLiveFreshPassingReviews: (fixLoopCertified ? passingReviews : freshPassing).filter(
      (review) => (review.validationDepth ?? 'full-live') === 'full-live',
    ).length,
    freshness,
  };
}

export function readyReviewBlockingDisplayReason(payload: ReadyGatePayload): string {
  const reviews = payload.independentReviews ?? [];
  const unresolved = reviews.find(
    (review) => review.verdict !== 'pass' || review.unresolvedCount > 0,
  );
  if (unresolved) {
    const issue =
      unresolved.issues?.[0] ?? unresolved.attempts?.flatMap((attempt) => attempt.issues ?? [])[0];
    if (issue || unresolved.unresolvedCount > 0) {
      const loc = issue
        ? `${issue.file}${issue.line ? `:${issue.line}` : ''}`
        : `${unresolved.unresolvedCount} unresolved`;
      return `${reviewSourceLabel(unresolved)} blocks: ${loc}`;
    }
    const freshness = classifyReviewFreshness(unresolved, payload);
    return `${freshness.label}: ${freshness.detail}`;
  }

  const counts = summarizeReviewCounts(payload);
  const firstStale = counts.freshness.find((entry) => entry.stale);
  if (counts.trustedPassingReviews < counts.requiredReviews) {
    if (firstStale) {
      return `Trusted passing reviews ${counts.trustedPassingReviews}/${counts.requiredReviews}; stale ignored: ${firstStale.detail}`;
    }
    return `Trusted passing reviews required ${counts.trustedPassingReviews}/${counts.requiredReviews}`;
  }
  if (counts.externalRequired && counts.externalFreshPassingReviews === 0) {
    return 'External fresh passing review required';
  }
  if (counts.fullLiveFreshPassingReviews === 0 && counts.requiredReviews > 0) {
    return 'Full live fresh review required';
  }
  if (firstStale) return `Review gate blocked; stale review ignored: ${firstStale.detail}`;
  return 'Review gate blocked; check package, evidence, and review status';
}

export function publishEvidenceDisplayRows(
  payload: ReadyGatePayload,
  selectedKeys: readonly string[] | undefined,
  candidates: readonly ArtifactRef[] | undefined,
): PublishEvidenceDisplayRow[] {
  const candidateRows = [...(candidates ?? payload.prPackage?.evidenceManifest ?? [])];
  const selected = new Set(
    selectedKeys ?? payload.prPackage?.selectedEvidenceKeys ?? candidateRows.map((a) => a.path),
  );
  const candidatePaths = new Set(candidateRows.map((artifact) => artifact.path));
  const rows: PublishEvidenceDisplayRow[] = candidateRows.map((artifact) => ({
    path: artifact.path,
    purpose: artifact.purpose,
    included: selected.has(artifact.path),
    dropped: false,
    label: artifact.path.split('/').pop() ?? artifact.path,
  }));
  for (const key of selected) {
    if (!candidatePaths.has(key)) {
      rows.push({
        path: key,
        purpose: 'dropped-after-refresh',
        included: false,
        dropped: true,
        label: key.split('/').pop() ?? key,
      });
    }
  }
  return rows;
}

/** Compact human token count: 3722374 → "3.72M", 51819 → "51.8k", 940 → "940". */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

export interface GateSummaryTokenRow {
  label: string;
  model: string;
  total: string;
}

/** Per-model token rollup row — raw `totalRaw` retained for bar widths / sorting. */
export interface GateSummaryModelRow {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  total: string;
  totalRaw: number;
  turns: number;
}

export interface GateSummaryChecklistRow {
  stepNumber: number;
  label: string;
  duration: string;
}

/** Compact human duration: 1500 → "1.5s", 65000 → "1.1m". */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export interface GateSummaryReviewRow {
  label: string;
  verdict: string;
  attempts: number;
  unresolvedCount: number;
  crossRunner: boolean;
  triggeredReWork: boolean;
}

/**
 * Derived, formatted view of a {@link GateSummary} for the shared gate-summary
 * panel. Reads only from the GateSummary projection (no ReadyGatePayload), so
 * the same selector + panel render at the publication gate AND the retrospective.
 */
export interface GateSummaryDisplay {
  headline: string;
  policyLabel: string | null;
  worker: string;
  selfReview: { status: string; reason: string | null; verdict: string | null } | null;
  reviews: GateSummaryReviewRow[];
  passingLabel: string;
  reWorkCount: number;
  unresolvedTotal: number;
  reWork: { tokens: string; loops: number; nudgeCount: number } | null;
  checklist: GateSummaryChecklistRow[];
  tokens: {
    mainWorker: GateSummaryTokenRow;
    reviews: GateSummaryTokenRow[];
    chainedLoops: Array<GateSummaryTokenRow & { flowType: string }>;
    byModel: GateSummaryModelRow[];
    grandTotal: string;
    sessionPaths: string[];
  };
}

export function gateSummaryDisplay(summary: GateSummary): GateSummaryDisplay {
  const review = summary.review;
  const reviewRows: GateSummaryReviewRow[] = review.independentReviews.map((r) => ({
    label: r.crossRunner ? 'Independent review \u00b7 runner diversity' : 'Independent review',
    verdict: r.verdict,
    attempts: r.attempts,
    unresolvedCount: r.unresolvedCount,
    crossRunner: r.crossRunner,
    triggeredReWork: r.triggeredReWork,
  }));
  const reWorkCount = reviewRows.filter((r) => r.triggeredReWork).length;
  const requiredLabel =
    review.requiredReviews != null
      ? `${review.passingReviews}/${review.requiredReviews}`
      : `${review.passingReviews}`;

  const t = summary.tokens;
  return {
    headline: summary.headline ?? review.summaryText ?? '',
    policyLabel: summary.gatePolicy
      ? `${summary.gatePolicy.owner}-owned${summary.gatePolicy.reason ? ` · ${summary.gatePolicy.reason}` : ''}`
      : null,
    worker: `${summary.worker.model ?? 'unknown model'} · ${summary.worker.turns} turns${summary.worker.outcome ? ` · ${summary.worker.outcome}` : ''}`,
    selfReview: review.selfReview
      ? {
          status: review.selfReview.status,
          reason: review.selfReview.reason ?? null,
          verdict: review.selfReview.verdict ?? null,
        }
      : null,
    reviews: reviewRows,
    passingLabel: `${requiredLabel} passing`,
    reWorkCount,
    unresolvedTotal: review.totalUnresolved,
    reWork: t.reWork
      ? {
          tokens: formatTokenCount(t.reWork.tokens),
          loops: t.reWork.loops,
          nudgeCount: t.reWork.nudgeCount ?? 0,
        }
      : null,
    checklist: (summary.checklist?.perStepMs ?? []).map((s) => ({
      stepNumber: s.stepNumber,
      label: s.label,
      duration: formatDurationMs(s.durationMs),
    })),
    tokens: {
      mainWorker: {
        label: 'Worker',
        model: t.mainWorker.model ?? 'unknown',
        total: formatTokenCount(t.mainWorker.total),
      },
      reviews: t.reviews.map((r) => ({
        label: r.id,
        model: r.model ?? 'unknown',
        total: formatTokenCount(r.total),
      })),
      chainedLoops: (t.familyChainedLoops ?? []).map((c) => ({
        label: c.runId.slice(0, 8),
        flowType: c.flowType,
        model: c.model ?? 'unknown',
        total: formatTokenCount(c.tokens.total),
      })),
      byModel: t.byModel.map((m) => ({
        model: m.model ?? 'unknown',
        input: formatTokenCount(m.input),
        output: formatTokenCount(m.output),
        cacheRead: formatTokenCount(m.cacheRead),
        total: formatTokenCount(m.total),
        totalRaw: m.total,
        turns: m.turns,
      })),
      grandTotal: formatTokenCount(t.familyTotalTokens),
      sessionPaths: t.runnerSessionPaths ?? [],
    },
  };
}

export function fixDeltaAbsenceReason(
  review: IndependentReviewStatus,
  attempt: IndependentReviewAttempt | undefined,
): string {
  const rowFixDelta = attempt?.fixDelta ?? review.fixDelta;
  const verdict = attempt?.verdict ?? review.verdict;
  const unresolvedCount = attempt?.unresolvedCount ?? review.unresolvedCount;
  const warn = unresolvedCount > 0 || verdict === 'issues' || verdict === 'failed';
  if (rowFixDelta) {
    if (rowFixDelta.source === 'unavailable' || rowFixDelta.missingReason) {
      return rowFixDelta.missingReason
        ? `No worker fix delta captured; reviewed package did not include a fix range (${rowFixDelta.missingReason}).`
        : 'No worker fix delta captured; reviewed package did not include a fix range.';
    }
    return 'No worker fix delta captured; reviewed package did not include a complete fix range.';
  }
  if (review.feedbackSent === false) {
    return 'No worker fix delta recorded for this audit-only review; findings were not auto-sent to the worker.';
  }
  if (warn) return 'No worker fix delta captured for this review loop.';
  return '';
}
