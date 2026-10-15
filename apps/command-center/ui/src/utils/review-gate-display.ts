import {
  type ArtifactRef,
  classifyReviewFreshness,
  type GateSummary,
  latestExhaustedReview,
  type ReadyGatePayload,
  type ReviewAttempt,
  reviewFixRetriesExhausted,
  type ReviewRequirementDisplay,
  reviewRetryCapReason,
  reviewRetryCount,
  reviewSourceLabel,
  type ReviewStatus,
  type Run,
  summarizeReviewCounts,
} from '@farmslot/protocol';

export {
  classifyReviewFreshness,
  effectiveRequiredReviewCount as effectiveReviewRequirement,
  normalizedReviewPolicy,
  type ReviewFreshnessDisplay,
  type ReviewFreshnessReason,
  type ReviewGateCountSummary,
  reviewSourceLabel,
  summarizeReviewCounts,
} from '@farmslot/protocol';

export interface PublishEvidenceDisplayRow {
  path: string;
  purpose: string;
  included: boolean;
  dropped: boolean;
  label: string;
}

export function reviewAttemptLabel(
  _review: ReviewStatus,
  attemptIndex: number,
  _attemptCount: number,
): string {
  return `Review round ${attemptIndex + 1}`;
}

export function reviewSegmentLabel(review: Pick<ReviewStatus, 'source'>, order: number): string {
  return `${reviewSourceLabel(review)} ${order}`;
}

const ACTIVE_REVIEW_CONTEXT_STATUSES = new Set(['launching', 'working', 'waiting']);

export function activePublicationReviewLabel(
  run: Pick<Run, 'agentContexts'> | undefined,
): string | null {
  const contexts = run?.agentContexts ?? [];
  if (
    contexts.some(
      (context) =>
        context.role === 'review-fix' && ACTIVE_REVIEW_CONTEXT_STATUSES.has(context.status),
    )
  ) {
    return 'Review fix';
  }
  if (
    contexts.some(
      (context) => context.role === 'review' && ACTIVE_REVIEW_CONTEXT_STATUSES.has(context.status),
    )
  ) {
    return 'Review';
  }
  return null;
}

export function compactHumanGateLabel(
  run: Pick<Run, 'agentContexts' | 'decisions' | 'engineState'> | undefined,
): string {
  const activeReview = activePublicationReviewLabel(run);
  if (activeReview) return activeReview.toLowerCase();
  if (run?.engineState?.publishGate?.reviewLaunchRejection) {
    return 'review launch paused';
  }
  if ((run?.engineState?.publishGate?.reviewSequence?.length ?? 0) > 0) {
    return 'review';
  }

  const decision = [...(run?.decisions ?? [])]
    .reverse()
    .find((candidate) => candidate.type === 'engine_human_gate' && !candidate.resolvedAt);
  if (decision?.actions.some((action) => action.id === 'approve-publish')) {
    return 'publish ready';
  }

  const reviews = run?.engineState?.publishGate?.reviews ?? [];
  if (latestExhaustedReview(reviews)) return 'review retries exhausted';
  if (reviews.some((review) => review.verdict === 'issues' || review.unresolvedCount > 0)) {
    return 'review blocked';
  }
  return 'operator gate';
}

export function readyReviewBlockingDisplayReason(payload: ReadyGatePayload): string {
  if (payload.gateReadiness && payload.gateReadiness.state !== 'ready') {
    return (
      payload.gateReadiness.reasons.map((reason) => reason.message).join(' ') ||
      'Gate prerequisites are still being collected.'
    );
  }
  const reviews = payload.reviews ?? [];
  const exhausted = latestExhaustedReview(reviews);
  if (exhausted) return reviewRetryCapReason(exhausted);
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

/** A child checklist unit's own step timings (ADR-060), shown under its parent step. */
export interface GateSummaryChecklistSubtaskGroup {
  id: string;
  /** Source ref basename, or `inline` — the same title the live progress block shows. */
  title: string;
  /** Full provenance for the row's tooltip: the unit id and its untruncated ref. */
  titleTooltip: string;
  rows: GateSummaryChecklistRow[];
}

export interface GateSummaryChecklistStepRow extends GateSummaryChecklistRow {
  subtasks?: GateSummaryChecklistSubtaskGroup[];
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
  review: { status: string; reason: string | null; verdict: string | null } | null;
  reviews: GateSummaryReviewRow[];
  passingLabel: string;
  reWorkCount: number;
  unresolvedTotal: number;
  reWork: { tokens: string; loops: number; nudgeCount: number } | null;
  checklist: GateSummaryChecklistStepRow[];
  tokens: {
    mainWorker: GateSummaryTokenRow;
    reviews: GateSummaryTokenRow[];
    chainedLoops: Array<GateSummaryTokenRow & { flowType: string }>;
    byModel: GateSummaryModelRow[];
    grandTotal: string;
    sessionPaths: string[];
  };
}

/**
 * Parent step timings with each child unit's own steps nested under the step it
 * hangs off (ADR-060). A child whose parent step has no recorded duration — the
 * run stopped before that box was ticked — still gets a row, so its work is not
 * dropped from the retrospective; the row states the step it belongs to and
 * carries no parent duration.
 */
function checklistRows(summary: GateSummary): GateSummaryChecklistStepRow[] {
  const checklist = summary.checklist;
  if (!checklist) return [];
  const rows: GateSummaryChecklistStepRow[] = checklist.perStepMs.map((step) => ({
    stepNumber: step.stepNumber,
    label: step.label,
    duration: formatDurationMs(step.durationMs),
  }));
  for (const unit of checklist.subtasks ?? []) {
    const ref = unit.source?.ref?.trim();
    const group: GateSummaryChecklistSubtaskGroup = {
      id: unit.id,
      title: ref ? ref.split('/').pop() || ref : 'inline',
      titleTooltip: ref ? `${unit.id} · ${unit.source?.kind} · ${ref}` : `${unit.id} · inline text`,
      rows: unit.perStepMs.map((step) => ({
        stepNumber: step.stepNumber,
        label: step.label,
        duration: formatDurationMs(step.durationMs),
      })),
    };
    const parent = rows.find((row) => row.stepNumber === unit.parent.stepNumber);
    if (parent) {
      parent.subtasks = [...(parent.subtasks ?? []), group];
      continue;
    }
    rows.push({
      stepNumber: unit.parent.stepNumber,
      label: `${unit.parent.checklist} step ${unit.parent.stepNumber}`,
      duration: formatDurationMs(0),
      subtasks: [group],
    });
  }
  return rows.sort((a, b) => a.stepNumber - b.stepNumber);
}

export function gateSummaryDisplay(
  summary: GateSummary,
  requirement?: ReviewRequirementDisplay,
): GateSummaryDisplay {
  const review = summary.review;
  const reviewRows: GateSummaryReviewRow[] = review.reviews.map((r) => ({
    label: reviewSourceLabel(r),
    verdict: r.verdict,
    attempts: r.attempts,
    unresolvedCount: r.unresolvedCount,
    triggeredReWork: r.triggeredReWork,
  }));
  const reWorkCount = reviewRows.filter((r) => r.triggeredReWork).length;
  const requiredLabel =
    review.requiredReviews != null
      ? `${review.passingReviews}/${review.requiredReviews}`
      : `${review.passingReviews}`;

  const t = summary.tokens;
  return {
    headline: requirement?.label ?? summary.headline ?? review.summaryText ?? '',
    policyLabel: summary.gatePolicy
      ? `${summary.gatePolicy.owner}-owned${summary.gatePolicy.reason ? ` · ${summary.gatePolicy.reason}` : ''}`
      : null,
    worker: `${summary.worker.model ?? 'unknown model'} · ${summary.worker.turns == null ? 'turns not captured' : `${summary.worker.turns} turns`}${summary.worker.outcome ? ` · ${summary.worker.outcome}` : ''}`,
    review:
      !requirement && review.review
        ? {
            status: review.review.status,
            reason: review.review.reason ?? null,
            verdict: review.review.verdict ?? null,
          }
        : null,
    reviews: reviewRows,
    passingLabel: requirement?.label ?? `${requiredLabel} passing`,
    reWorkCount,
    unresolvedTotal: review.totalUnresolved,
    reWork: t.reWork
      ? {
          tokens: formatTokenCount(t.reWork.tokens),
          loops: t.reWork.loops,
          nudgeCount: t.reWork.nudgeCount ?? 0,
        }
      : null,
    checklist: checklistRows(summary),
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

/**
 * True when a review still owes a worker fix and a re-review: the engine
 * marked `recoveryContinuationPending` AND the final attempt left unresolved
 * findings. `feedbackSent` deliberately plays no part — an exhausted or
 * recovery-restored loop records `feedbackSent: false` because its final
 * findings were never delivered, and those rows need the pending phases
 * exactly as much as a continuation whose feedback did reach the worker.
 */
export function reviewHasPendingContinuationPhases(
  review: Pick<ReviewStatus, 'recoveryContinuationPending'> &
    Partial<
      Pick<
        ReviewStatus,
        | 'source'
        | 'verdict'
        | 'unresolvedCount'
        | 'issues'
        | 'feedbackSent'
        | 'retryCount'
        | 'maxRetries'
        | 'maxRetriesExhausted'
        | 'attempts'
      >
    >,
  finalAttempt: Pick<ReviewAttempt, 'unresolvedCount'> | undefined,
): boolean {
  if (review.verdict === 'issues' && reviewFixRetriesExhausted(review)) return false;
  return review.recoveryContinuationPending === true && (finalAttempt?.unresolvedCount ?? 0) > 0;
}

export function reviewRetryCapPhaseLabel(review: ReviewStatus): string | null {
  if (!reviewFixRetriesExhausted(review)) return null;
  const retryCount = reviewRetryCount(review);
  return typeof review.maxRetries === 'number'
    ? `exhausted ${retryCount}/${review.maxRetries}`
    : `exhausted after ${retryCount} attempt${retryCount === 1 ? '' : 's'}`;
}

export function fixDeltaAbsenceReason(
  review: ReviewStatus,
  attempt: ReviewAttempt | undefined,
): string {
  const rowFixDelta = attempt ? attempt.fixDelta : review.fixDelta;
  const verdict = attempt?.verdict ?? review.verdict;
  const unresolvedCount = attempt?.unresolvedCount ?? review.unresolvedCount;
  const warn = unresolvedCount > 0 || verdict === 'issues' || verdict === 'failed';
  if (rowFixDelta) {
    if (rowFixDelta.source === 'unavailable' || rowFixDelta.missingReason) {
      return rowFixDelta.missingReason
        ? `No worker fix delta captured; reviewed package did not include a fix range (${rowFixDelta.missingReason}).`
        : 'No worker fix delta captured; reviewed package did not include a fix range.';
    }
    if (!hasMeaningfulReviewFixDelta(rowFixDelta)) {
      return 'No tracked worker change was recorded for this review loop.';
    }
    return 'No worker fix delta captured; reviewed package did not include a complete fix range.';
  }
  if (review.feedbackSent === false) {
    return 'No worker fix delta recorded for this audit-only review; findings were not auto-sent to the worker.';
  }
  if (warn) return 'No worker fix delta captured for this review loop.';
  return '';
}

export function hasMeaningfulReviewFixDelta(delta: unknown): boolean {
  if (!delta || typeof delta !== 'object') return false;
  const snapshot = delta as Record<string, unknown>;
  const base =
    typeof snapshot.fixBaseSha === 'string'
      ? snapshot.fixBaseSha
      : typeof snapshot.baseSha === 'string'
        ? snapshot.baseSha
        : undefined;
  const head =
    typeof snapshot.fixHeadSha === 'string'
      ? snapshot.fixHeadSha
      : typeof snapshot.headSha === 'string'
        ? snapshot.headSha
        : undefined;
  if (!base || !head || base === head) return false;
  if (!snapshot.diffStat || typeof snapshot.diffStat !== 'object') return true;
  const files = (snapshot.diffStat as Record<string, unknown>).files;
  return typeof files !== 'number' || files > 0;
}
