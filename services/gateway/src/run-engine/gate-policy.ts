import {
  APPROVE_PUBLISH_ACTION,
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type DecisionAction,
  effectiveRequiredReviewCount,
  EVIDENCE_ATTESTATION_ACTION,
  type EvidenceManifestEntry,
  isPublishApprovalAction,
  isQualifyingReview,
  latestExhaustedReview,
  type NoChangeGatePayload,
  PUBLISH_APPROVAL_ACTIONS,
  qualifyingPassingReviews,
  type ReadyGatePrPackage,
  type ReviewAttempt,
  type ReviewDiffSnapshot,
  reviewFindingsSatisfied,
  reviewFixRetriesExhausted,
  type ReviewPolicy,
  reviewPolicySatisfied,
  reviewRetryCapReason,
  type ReviewStatus,
  type Run,
  type RunDecision,
  SEND_BACK_TO_AGENT_ACTION,
  stampReviewRetryCap,
  type WorkerTerminalDisposition,
  type WorkerTerminalEvidence,
} from '@farmslot/protocol';
import { publicationReviewBlockingReason, resolveReviewMode } from '@farmslot/review-dispatch';

export { publicationReviewBlockingReason } from '@farmslot/review-dispatch';

import { REQUESTED_REVIEW_SOURCE, reviewLoopNumberFromId } from '../quality/review-sources.js';
import type { ReviewResult } from '../review/orchestrator.js';
import { preserveUnchangedReviewFindings } from '../review/retained-findings.js';
import { runReviewRoundBudget } from '../review/review-round-budget.js';
import { acceptedReviewFixPredecessor } from '../review/terminal-result.js';
import { resolveSelectedEvidenceRef } from '../run-completion/evidence-paths.js';
import { assertPublicationEvidenceSelection } from '../run-completion/publication-evidence-policy.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { publicationReviewPolicyForRun } from './publication-policy.js';

export {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  isPublishApprovalAction,
  PUBLISH_APPROVAL_ACTIONS,
};

/**
 * Gate action offered when the run's branch already shipped out-of-band (merged
 * PR, or zero commits ahead of the default branch). Resolving it links the
 * merged PR when discoverable and completes the run without re-publishing.
 */
export const CLOSE_AS_SHIPPED_ACTION = 'close-as-shipped';

/** Continue the latest issues review from its persisted findings. */
export const CONTINUE_REVIEW_FIX_ACTION = 'continue-review-fix';

export function reviewerIsActiveForReview(
  run: Pick<Run, 'agentContexts'>,
  review: Pick<ReviewStatus, 'id'>,
): boolean {
  return (run.agentContexts ?? []).some(
    (context) =>
      context.role === 'review' &&
      ['launching', 'working', 'waiting'].includes(context.status) &&
      context.artifactScope === review.id,
  );
}

export function publicationGateDecisionActions(opts: {
  reviewSatisfied: boolean;
  mergedPrNumber?: number | null;
  branchZeroAhead?: boolean;
  evidenceRefreshAction?: DecisionAction | null;
  unavailableSnapshotAction?: DecisionAction | null;
  pendingReviewContinuation?: ReviewStatus;
  /** Qualified Issues can return to the retained worker within the existing fix budget. */
  sendBackToAgent?: boolean;
  /** The review loop an active Send back owns; its fixes continue only through Send back. */
  visualRepairReviewId?: string;
  reviews?: ReviewStatus[];
  preparedPackage?: Pick<
    ReadyGatePrPackage,
    'headSha' | 'reviewSubjectHash' | 'reviewSnapshot' | 'reviewPolicy'
  > | null;
}): DecisionAction[] {
  const exhausted = latestExhaustedReview(opts.reviews);
  const continueFix =
    opts.pendingReviewContinuation &&
    !reviewFixRetriesExhausted(opts.pendingReviewContinuation) &&
    opts.pendingReviewContinuation.id !== opts.visualRepairReviewId
      ? opts.pendingReviewContinuation
      : undefined;
  return [
    ...(opts.preparedPackage ? [{ ...EVIDENCE_ATTESTATION_ACTION }] : []),
    ...(opts.mergedPrNumber || opts.branchZeroAhead
      ? [
          {
            id: CLOSE_AS_SHIPPED_ACTION,
            label: opts.mergedPrNumber
              ? `Close as Shipped (PR #${opts.mergedPrNumber} merged)`
              : 'Close as Shipped (branch has no commits ahead)',
            style: 'primary' as const,
          },
        ]
      : []),
    ...(opts.reviewSatisfied
      ? [{ id: APPROVE_PUBLISH_ACTION, label: 'Approve Publish', style: 'primary' as const }]
      : []),
    ...(opts.evidenceRefreshAction ? [opts.evidenceRefreshAction] : []),
    ...(opts.unavailableSnapshotAction ? [opts.unavailableSnapshotAction] : []),
    ...(continueFix
      ? [
          {
            id: CONTINUE_REVIEW_FIX_ACTION,
            label: `Continue Fixing ${continueFix.unresolvedCount} Finding${continueFix.unresolvedCount === 1 ? '' : 's'}`,
            style: 'primary' as const,
          },
        ]
      : []),
    ...(opts.sendBackToAgent
      ? [{ id: SEND_BACK_TO_AGENT_ACTION, label: 'Send back to agent', style: 'primary' as const }]
      : []),
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
    {
      id: 'request-review',
      label: 'Request Review',
      style: exhausted ? ('primary' as const) : ('secondary' as const),
      ...(exhausted
        ? {
            description: 'Start a new review. Remaining findings are not auto-sent.',
          }
        : {}),
    },
    // Gate readiness alone decides when accepting findings is offered (ADR-065 Amendment 8).
    ...(opts.preparedPackage
      ? [
          {
            id: APPROVE_PUBLISH_UNRESOLVED_ACTION,
            label: 'Accept Review Findings and Publish',
            style: 'danger' as const,
            description: `${exhausted ? `${reviewRetryCapReason(exhausted)} ` : ''}Publish this package with its open review findings accepted. Your reason, the findings and your identity appear in the PR. Every other prerequisite still applies.`,
          },
        ]
      : []),
  ];
}

export function reviewNeedsContinuation(
  review: Pick<
    ReviewStatus,
    | 'source'
    | 'verdict'
    | 'feedbackSent'
    | 'recoveryContinuationPending'
    | 'unresolvedCount'
    | 'issues'
    | 'retryCount'
    | 'maxRetries'
    | 'maxRetriesExhausted'
    | 'attempts'
  >,
): boolean {
  return review.recoveryContinuationPending === true && undeliveredReviewFindings(review);
}

/** Findings the review loop has not delivered to the worker, with fix retries left. */
function undeliveredReviewFindings(review: Parameters<typeof reviewNeedsContinuation>[0]): boolean {
  return (
    review.verdict === 'issues' &&
    review.feedbackSent !== true &&
    review.unresolvedCount > 0 &&
    (review.issues?.length ?? 0) > 0 &&
    !reviewFixRetriesExhausted(review)
  );
}

/**
 * Repair the old exhausted-loop shape where `feedbackSent` described an
 * earlier generation even though the final ISSUES attempt had never reached
 * the worker. A sent fix necessarily creates another attempt, so an exhausted
 * review whose last attempt still ends in ISSUES has pending final findings —
 * including the single-attempt case, where the loop stopped before any fix
 * generation landed and `feedbackSent: true` can only be legacy carry-over.
 */
export function normalizeExhaustedReviewContinuation(review: ReviewStatus): ReviewStatus {
  const finalAttempt = review.attempts?.at(-1);
  if (
    review.verdict !== 'issues' ||
    review.unresolvedCount <= 0 ||
    (review.issues?.length ?? 0) === 0 ||
    review.feedbackSent !== true ||
    review.recoveryContinuationPending === true ||
    reviewFixRetriesExhausted(review) ||
    !finalAttempt ||
    finalAttempt.verdict !== 'issues' ||
    finalAttempt.unresolvedCount <= 0
  ) {
    return review;
  }
  return {
    ...review,
    feedbackSent: false,
    recoveryContinuationPending: true,
  };
}

/** Return the newest continuation that no later terminal review superseded. */
export function pendingReviewContinuation(
  reviews: readonly ReviewStatus[],
): ReviewStatus | undefined {
  const latest = latestTerminalReview(reviews);
  return latest && reviewNeedsContinuation(latest) ? latest : undefined;
}

function latestTerminalReview(reviews: readonly ReviewStatus[]): ReviewStatus | undefined {
  return [...reviews]
    .reverse()
    .find((review) => review.verdict === 'pass' || review.verdict === 'issues');
}

/**
 * The review whose findings the publish gate can continue, only while a review round is
 * available (ADR-063 Amendment 4): a pending continuation, or findings at `headSha` the loop
 * never delivered because the round budget stopped it. Recovery reads only
 * pendingReviewContinuation, so a restart never delivers them on its own; a person chooses
 * Continue Fixing.
 */
export function gateReviewContinuation(
  reviews: readonly ReviewStatus[],
  { roundAvailable, headSha }: { roundAvailable: boolean; headSha?: string | null },
): ReviewStatus | undefined {
  if (!roundAvailable) return undefined;
  const pending = pendingReviewContinuation(reviews);
  if (pending) return pending;
  const latest = latestTerminalReview(reviews);
  if (!latest || !undeliveredReviewFindings(latest)) return undefined;
  const reviewedHead = latest.reviewSnapshot?.headSha ?? latest.reviewedHeadSha;
  return headSha && reviewedHead !== headSha ? undefined : latest;
}

/** gateReviewContinuation for this run's reviews and current round budget. */
export async function gateReviewContinuationForRun(
  run: Run,
  headSha?: string | null,
): Promise<ReviewStatus | undefined> {
  return gateReviewContinuation(run.engineState?.publishGate?.reviews ?? [], {
    roundAvailable: (await runReviewRoundBudget(run)).remaining > 0,
    headSha,
  });
}

export function isOwnPrApprovalError(err: unknown): boolean {
  const maybeRecord = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const text = [maybeRecord?.message, maybeRecord?.stdout, maybeRecord?.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();

  return /\b(can ?not|cannot)\s+approve\s+your\s+own\s+pull\s+request\b/.test(text);
}

/**
 * `prNumber` field uses `0` as an invalid sentinel (review-input capture and
 * other PR-bound paths reject it explicitly). Treat any non-positive value the
 * same as `null` so chained dispatches and CLI hints don't poison downstream
 * calls with `owner/repo#0` or pass `0` to PR-aware monitors.
 */
export function hasValidPrNumber(run: Pick<Run, 'prNumber'>): boolean {
  return run.prNumber != null && run.prNumber > 0;
}

export function shouldForceNoChangeHumanGate(run: Pick<Run, 'metrics'>): boolean {
  return isNoCodeTerminalDisposition(run.metrics.disposition);
}

export function noChangeDispositionLabel(
  disposition: WorkerTerminalDisposition | null | undefined,
): string {
  switch (disposition) {
    case 'already_fixed':
      return 'already fixed';
    case 'not_reproducible':
      return 'not reproducible';
    default:
      return disposition ?? 'unknown';
  }
}

export function buildPublishGateReviewStatus({
  source,
  priorReviewCount,
  reviewResult,
  requestedRunner,
  model,
  effort,
  reviewId,
  reviewedPackage,
}: {
  source: 'dispatch' | 'human-gate';
  priorReviewCount: number;
  reviewResult: ReviewResult;
  requestedRunner: string | null;
  model?: string | null;
  effort?: string | null;
  reviewId?: string;
  reviewedPackage?: Pick<
    ReadyGatePrPackage,
    'headSha' | 'packageInputHash' | 'reviewSubjectHash'
  > | null;
}): ReviewStatus {
  const attempts: ReviewAttempt[] =
    Array.isArray(reviewResult.attempts) && reviewResult.attempts.length
      ? reviewResult.attempts
      : [
          {
            loopNumber: 1,
            mode: resolveReviewMode({ explicitMode: reviewResult.mode }),
            verdict: reviewResult.skipped
              ? 'skipped'
              : reviewResult.verdict === 'pass'
                ? 'pass'
                : reviewResult.verdict === 'blocked'
                  ? 'failed'
                  : reviewResult.verdict === 'issues'
                    ? 'issues'
                    : 'pending',
            unresolvedCount:
              reviewResult.verdict === 'pass' ? 0 : (reviewResult.issues?.length ?? 0),
            ...(reviewResult.reason ? { reason: reviewResult.reason } : {}),
            ...(reviewResult.issues?.length ? { issues: reviewResult.issues } : {}),
            reviewSnapshot: reviewResult.reviewSnapshot,
            fixDelta: reviewResult.fixDelta,
            validationDepth: reviewResult.validationDepth,
            ...(reviewResult.usage ? { usage: reviewResult.usage } : {}),
            ...(reviewResult.taskProgressArtifactPath
              ? { taskProgressArtifactPath: reviewResult.taskProgressArtifactPath }
              : {}),
            ...(reviewResult.timeline?.length ? { timeline: reviewResult.timeline } : {}),
          },
        ];
  const finalAttempt = attempts.at(-1)!;
  const reviewRunner = reviewResult.runner ?? requestedRunner ?? null;
  const resolvedReviewId =
    reviewId ?? REQUESTED_REVIEW_SOURCE.artifactRefs(priorReviewCount + 1).id;
  const status: ReviewStatus = {
    id: resolvedReviewId,
    source,
    mode: resolveReviewMode({ explicitMode: finalAttempt.mode, defaultMode: reviewResult.mode }),
    session: finalAttempt.session ?? reviewResult.session,
    runner: reviewRunner,
    model: reviewResult.model ?? model ?? null,
    ...(reviewResult.effort?.trim() || effort?.trim()
      ? { effort: reviewResult.effort?.trim() || effort?.trim() }
      : {}),
    reviewerSessionId:
      reviewResult.reviewerSessionId ??
      finalAttempt.usage?.runnerSessionId ??
      reviewResult.usage?.runnerSessionId ??
      null,
    loopNumber:
      reviewLoopNumberFromId(REQUESTED_REVIEW_SOURCE, resolvedReviewId) ?? priorReviewCount + 1,
    verdict: finalAttempt.verdict,
    unresolvedCount: finalAttempt.unresolvedCount,
    ...((finalAttempt.reason ?? reviewResult.reason)
      ? { reason: finalAttempt.reason ?? reviewResult.reason }
      : {}),
    issues:
      finalAttempt.issues ?? (finalAttempt.unresolvedCount > 0 ? reviewResult.issues : undefined),
    validationDepth: finalAttempt.validationDepth ?? reviewResult.validationDepth,
    usage: finalAttempt.usage ?? reviewResult.usage,
    feedbackSent: reviewResult.feedbackSent === true,
    recoveryContinuationPending: reviewResult.recoveryContinuationPending === true,
    ...(typeof reviewResult.retryCount === 'number' ? { retryCount: reviewResult.retryCount } : {}),
    ...(typeof reviewResult.maxRetries === 'number' ? { maxRetries: reviewResult.maxRetries } : {}),
    ...(reviewResult.verdict === 'issues' &&
    (reviewResult.issues?.length ?? 0) > 0 &&
    typeof reviewResult.maxRetries === 'number' &&
    reviewResult.maxRetries > 0 &&
    reviewResult.retryCount >= reviewResult.maxRetries
      ? { maxRetriesExhausted: true as const, recoveryContinuationPending: false }
      : {}),
    attempts,
    artifactPaths: [...new Set(attempts.flatMap((attempt) => attempt.artifactPaths ?? []))],
    taskProgressArtifactPath: finalAttempt.taskProgressArtifactPath,
    timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
    reviewSnapshot: finalAttempt.reviewSnapshot,
    reviewedHeadSha: finalAttempt.reviewSnapshot?.headSha ?? undefined,
    fixDelta: finalAttempt.fixDelta,
    startedAt: attempts[0]?.startedAt,
    completedAt: finalAttempt.completedAt ?? new Date().toISOString(),
  };
  const capped = stampReviewRetryCap(
    preserveUnchangedReviewFindings(status),
    reviewResult.maxRetries,
  );
  if (!reviewedPackage) return capped;
  const finalReviewedHeadSha = capped.reviewSnapshot?.headSha ?? null;
  const reviewedPackageHeadSha = reviewedPackage.headSha ?? null;
  // A review loop can legitimately find issues, let the worker fix them, and
  // then pass a re-review on a new HEAD. In that case the overall review
  // certifies the final attempt's HEAD, not the package that was current before
  // the loop started. Do not stamp the old package over the fresh re-review
  // snapshot; the post-review package refresh will stamp the freshly prepared
  // package after confirming the final snapshot HEAD matches.
  if (
    finalReviewedHeadSha &&
    reviewedPackageHeadSha &&
    finalReviewedHeadSha !== reviewedPackageHeadSha
  ) {
    return capped;
  }
  return stampPublishGateReviewStatusForPackage(capped, reviewedPackage);
}

export function stampPublishGateReviewStatusForPackage(
  review: ReviewStatus,
  reviewedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'packageInputHash' | 'reviewSubjectHash'>,
): ReviewStatus {
  return {
    ...review,
    reviewedHeadSha: reviewedPackage.headSha ?? review.reviewSnapshot?.headSha ?? null,
    reviewedPackageInputHash: reviewedPackage.packageInputHash ?? null,
    reviewedReviewSubjectHash: reviewedPackage.reviewSubjectHash ?? null,
  };
}

// Pure composition helper for the no-change gate. Splits the markdown
// description and the NoChangeGatePayload off so they can be unit-tested
// without standing up a full Run / decision pipeline.
export function buildNoChangeGateInputs(args: {
  disposition: 'already_fixed' | 'not_reproducible';
  ticketOrPr: string;
  monitorReason?: string;
  evidence?: WorkerTerminalEvidence;
  report?: string | null;
  artifactManifest?: EvidenceManifestEntry[];
}): { desc: string; payload: NoChangeGatePayload } {
  const { disposition, ticketOrPr, monitorReason, evidence, report, artifactManifest } = args;
  const evidenceLines = [
    evidence?.reportPath ? `- report: \`${evidence.reportPath}\`` : null,
    ...(evidence?.artifacts?.map((artifact) => `- artifact: \`${artifact}\``) ?? []),
    evidence?.confidence ? `- confidence: ${evidence.confidence}` : null,
  ].filter((line): line is string => Boolean(line));
  const desc = [
    `Worker reported **${noChangeDispositionLabel(disposition)}** for ${ticketOrPr}.`,
    monitorReason ? `Worker reason: ${monitorReason}` : null,
    evidenceLines.length ? `Evidence:\n${evidenceLines.join('\n')}` : 'Evidence: none reported.',
    report ? `\nReport excerpt:\n\n${report.slice(0, 600)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const payload: NoChangeGatePayload = {
    kind: 'no-change',
    disposition,
    reason: monitorReason,
    evidence,
    workerReport: report ?? undefined,
    artifactManifest,
  };
  return { desc, payload };
}

// Pure rejection-message picker. Returns the operator-facing error string
// the gate writes onto the run when the human picks reject-retry or
// mark-blocked. Extracted alongside buildNoChangeGateInputs so the two
// branch outputs can be asserted directly.
export function noChangeRejectionMessage(
  actionId: 'reject-retry' | 'mark-blocked',
  ticketOrPr: string,
): string {
  return actionId === 'reject-retry'
    ? `No-change result rejected; retry reproduction for ${ticketOrPr}`
    : `No-change result marked blocked; insufficient evidence for ${ticketOrPr}`;
}

const GATE_REENTRY = 'gate-reentry';

/**
 * A gateway restart kills the engine loop that owned a pending human/review gate
 * decision; re-entering the gate then presents a NEW decision. Any older
 * unresolved gate decision must be closed out first — two pending gate
 * decisions mean an approval can land on one no live loop owns (observed: the
 * approve resolved the dead loop's decision and the run stalled at
 * pending_publish). Resolves stale ones as superseded — kept for audit, never
 * silently deleted — and returns how many were superseded.
 */
export function supersedeStaleHumanGateDecisions(
  decisions: RunDecision[],
  nowIso: string = new Date().toISOString(),
): number {
  let superseded = 0;
  for (const decision of decisions) {
    if (
      (decision.type !== 'engine_human_gate' && decision.type !== 'engine_review_posting') ||
      decision.resolvedAt
    )
      continue;
    decision.resolvedAt = nowIso;
    decision.resolvedAction = 'superseded';
    decision.context = { ...decision.context, supersededBy: GATE_REENTRY };
    superseded += 1;
  }
  return superseded;
}

/**
 * Undo `supersedeStaleHumanGateDecisions` for `ids`: a replay that superseded them and
 * then failed before reviving the run leaves the gate as it was. Returns the new list
 * and the reopened decisions; a decision since resolved otherwise is left alone.
 */
export function reopenSupersededGateDecisions(
  decisions: RunDecision[],
  ids: ReadonlySet<string>,
): { decisions: RunDecision[]; reopened: RunDecision[] } {
  const reopened: RunDecision[] = [];
  const next = decisions.map((decision) => {
    if (
      !ids.has(decision.id) ||
      decision.resolvedAction !== 'superseded' ||
      decision.context?.supersededBy !== GATE_REENTRY
    )
      return decision;
    const { resolvedAt: _resolvedAt, resolvedAction: _resolvedAction, ...open } = decision;
    const { supersededBy: _supersededBy, ...context } = decision.context;
    const restored = { ...open, context };
    reopened.push(restored);
    return restored;
  });
  return { decisions: next, reopened };
}

export function validatePackageApprovalSelection(
  preparedPackage: ReadyGatePrPackage,
  decision: RunDecision | undefined,
): void {
  const refreshGuidance =
    preparedPackage.reviewPolicy && effectiveRequiredReviewCount(preparedPackage.reviewPolicy) === 0
      ? 'refresh package before publishing'
      : 'refresh package and re-review before publishing';
  const packageChanged = (detail: string): Error =>
    new Error(`Package changed; ${refreshGuidance} (${detail})`);
  const selection = decision?.selectionData ?? {};
  const packageId = typeof selection.packageId === 'string' ? selection.packageId : '';
  const packageHash = typeof selection.packageHash === 'string' ? selection.packageHash : '';
  const packageHeadSha =
    typeof selection.packageHeadSha === 'string' ? selection.packageHeadSha : '';
  if (packageId !== preparedPackage.id) {
    throw packageChanged(
      `approved package ${packageId || 'missing'} but current package is ${preparedPackage.id}`,
    );
  }
  if (packageHash !== preparedPackage.packageHash) {
    throw packageChanged(
      `approved package hash ${packageHash || 'missing'} but current package is ${preparedPackage.packageHash}`,
    );
  }
  if (!preparedPackage.headSha) {
    throw packageChanged('package HEAD SHA missing');
  }
  if (packageHeadSha !== preparedPackage.headSha) {
    throw packageChanged(
      `approved HEAD ${packageHeadSha || 'missing'} but current package is ${preparedPackage.headSha}`,
    );
  }
  const selectedEvidenceKeys = selection.selectedEvidenceKeys;
  if (
    Array.isArray(selectedEvidenceKeys) &&
    !selectedEvidenceKeysMatchPackageSelection(preparedPackage, selectedEvidenceKeys)
  ) {
    throw packageChanged('selected evidence differs from the prepared package');
  }
  assertPublicationEvidenceSelection({
    selectedEvidenceKeys: Array.isArray(selectedEvidenceKeys)
      ? selectedEvidenceKeys
      : preparedPackage.selectedEvidenceKeys,
    evidenceManifest: preparedPackage.evidenceManifest ?? [],
    trustedEvidenceManifest: undefined,
  });
}

function canonicalEvidenceSelectionForPackage(
  preparedPackage: ReadyGatePrPackage,
  keys: readonly string[] | undefined,
): string[] {
  const manifest = preparedPackage.evidenceManifest ?? [];
  const resolve = (key: string): string => resolveSelectedEvidenceRef(key, manifest)?.path ?? key;
  return [
    ...new Set((keys ?? []).filter((key): key is string => typeof key === 'string').map(resolve)),
  ].sort();
}

function selectedEvidenceKeysMatchPackageSelection(
  preparedPackage: ReadyGatePrPackage,
  selectedEvidenceKeys: readonly string[] | undefined,
): boolean {
  if (!Array.isArray(selectedEvidenceKeys)) return true;
  const expected = canonicalEvidenceSelectionForPackage(
    preparedPackage,
    preparedPackage.selectedEvidenceKeys,
  );
  const actual = canonicalEvidenceSelectionForPackage(preparedPackage, selectedEvidenceKeys);
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

export function reviewFinalSnapshotMatchesPreparedPackage(
  review: ReviewStatus,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot'>,
): boolean {
  if (!reviewFindingsSatisfied(review)) return false;
  const snapshot = review.reviewSnapshot;
  if (!snapshot || snapshot.source === 'unavailable') return false;
  if (!preparedPackage.headSha || snapshot.headSha !== preparedPackage.headSha) return false;
  return reviewSnapshotDiffMatchesPackage(snapshot, preparedPackage, review);
}

function reviewSnapshotDiffMatchesPackage(
  snapshot: ReviewDiffSnapshot,
  preparedPackage: Pick<ReadyGatePrPackage, 'reviewSnapshot'>,
  review?: ReviewStatus,
): boolean {
  const preparedSnapshot = preparedPackage.reviewSnapshot;
  if (!preparedSnapshot || preparedSnapshot.source === 'unavailable') return false;
  const session = review?.session;
  const deltaFallback = review?.mode === 'cold' ? session?.fallback : undefined;
  if (review && (review.mode === 'warm' || deltaFallback)) {
    // Gateway acceptance extends the captured delta without claiming another reviewer turn.
    const acceptedFix = deltaFallback ? acceptedReviewFixPredecessor(review) : undefined;
    const compared = acceptedFix?.reviewSnapshot ?? snapshot;
    // A fresh fallback keeps its authorized delta, whose base can differ from
    // the publication package's full contribution. Its new baseline is head.
    const rangeMatches = deltaFallback
      ? !!snapshot.baseSha &&
        !!snapshot.diffHash &&
        session?.lastReviewedHeadSha === compared.headSha &&
        deltaFallback.comparedRanges.at(-1) === `${compared.baseSha}..${compared.headSha}`
      : snapshot.baseRef === preparedSnapshot.baseRef &&
        snapshot.baseSha === session?.lastReviewedHeadSha;
    return (
      snapshot.source !== 'unavailable' &&
      session?.mode === review.mode &&
      session.continuity === (deltaFallback ? 'fresh' : 'resumed') &&
      session.reviewId === review.id &&
      !!session.sessionId &&
      session.sessionId === review.reviewerSessionId &&
      !!session.lastReviewedHeadSha &&
      snapshot.headSha === preparedSnapshot.headSha &&
      rangeMatches
    );
  }
  return (
    snapshot.baseRef === preparedSnapshot.baseRef &&
    snapshot.baseSha === preparedSnapshot.baseSha &&
    snapshot.headSha === preparedSnapshot.headSha &&
    snapshot.diffHash === preparedSnapshot.diffHash
  );
}

/**
 * Per-review staleness diagnosis against the prepared package's review subject.
 * `headDrift` means the review certified a different (or missing) HEAD SHA than
 * the prepared package — a real code change that mandates re-review.
 * `diffDrift` means the worktree snapshot differs at the same HEAD (for example
 * uncommitted files), which also mandates re-review.
 * `subjectDrift` means the reviewed subject hash no longer matches — typically
 * caused by an evidence/package refresh that regenerated artifact digests even
 * though the reviewed code (HEAD) is unchanged. The two reasons are kept
 * separate so the human evidence-refresh override can target subject-only drift.
 */
interface PublicationReviewStaleness {
  stale: boolean;
  headDrift: boolean;
  diffDrift: boolean;
  subjectDrift: boolean;
}

function diagnosePublicationReviewStaleness(
  review: ReviewStatus,
  packageReviewSubjectHash: string,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot'>,
): PublicationReviewStaleness {
  const snapshot = review.reviewSnapshot;
  const reviewedHeadSha = review.reviewedHeadSha ?? snapshot?.headSha ?? null;
  const reviewedSubjectHash = review.reviewedReviewSubjectHash ?? null;
  const subjectDrift = reviewedSubjectHash !== packageReviewSubjectHash;
  const diffDrift =
    !snapshot || !reviewSnapshotDiffMatchesPackage(snapshot, preparedPackage, review);
  const headDrift =
    !reviewedHeadSha ||
    reviewedHeadSha !== preparedPackage.headSha ||
    (!review.reviewedHeadSha && (!snapshot || snapshot.source === 'unavailable'));
  return {
    stale: headDrift || diffDrift || subjectDrift,
    headDrift,
    diffDrift,
    subjectDrift,
  };
}

/** True when a review was captured for the exact prepared package subject and HEAD. */
export function publicationReviewMatchesPreparedPackage(
  review: ReviewStatus,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot' | 'reviewSubjectHash'>,
): boolean {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return false;
  return !diagnosePublicationReviewStaleness(review, packageReviewSubjectHash, preparedPackage)
    .stale;
}

export function countStalePublicationReviews(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
): number {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return reviews.filter(isQualifyingReview).length;
  const reviewPolicy = {
    minimumReviews: preparedPackage.reviewPolicy?.minimumReviews ?? 1,
    requestedBy: preparedPackage.reviewPolicy?.requestedBy ?? 'dispatch',
  };
  const freshReviews = qualifyingPassingReviews(reviews).filter((review) =>
    reviewCertifiesPreparedPackage(review, preparedPackage),
  );
  if (freshPublicationReviewCountSatisfied(reviewPolicy, freshReviews)) return 0;
  return reviews.filter(
    (review) =>
      isQualifyingReview(review) &&
      diagnosePublicationReviewStaleness(review, packageReviewSubjectHash, preparedPackage).stale,
  ).length;
}

interface StaleApprovalClassification {
  /** Stale approving reviews caused purely by subject/evidence drift (HEAD unchanged). */
  evidenceOnly: ReviewStatus[];
  /** A stale approving review certified a different/missing HEAD — a real code change. */
  hasHeadDriftedApproval: boolean;
}

/**
 * Single source of truth for "which stale approving reviews are evidence-only".
 * Partitions stale approving reviews (verdict pass, no unresolved, cross-runner
 * satisfied) into those caused purely by subject/evidence drift on a still-
 * matching HEAD and those that are HEAD-drifted (real code change). Returns null
 * when the package has no review subject hash to compare against. Both the
 * override-availability check and the restamp consume this so their eligibility
 * criteria can never drift apart, and each review is diagnosed exactly once.
 */
function classifyStaleApprovingReviews(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
): StaleApprovalClassification | null {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return null;
  const evidenceOnly: ReviewStatus[] = [];
  let hasHeadDriftedApproval = false;
  for (const review of reviews) {
    if (!isQualifyingReview(review)) continue;
    if (review.verdict !== 'pass' || review.unresolvedCount !== 0) continue;
    const diagnosis = diagnosePublicationReviewStaleness(
      review,
      packageReviewSubjectHash,
      preparedPackage,
    );
    if (!diagnosis.stale) continue;
    if (diagnosis.subjectDrift && !diagnosis.headDrift && !diagnosis.diffDrift)
      evidenceOnly.push(review);
    else hasHeadDriftedApproval = true;
  }
  return { evidenceOnly, hasHeadDriftedApproval };
}

/**
 * True when the publish gate is blocked purely by evidence/subject drift on the
 * prepared package while the reviewed HEAD still matches — i.e. a package
 * refresh regenerated evidence digests but the reviewed code is unchanged. In
 * that case the operator may use the `approve-publish-evidence-refresh`
 * override to carry the prior pass verdict forward without a needless re-review.
 *
 * Returns false (override unavailable) when any stale approving review is stale
 * due to HEAD drift (real code change) or when no stale approving review exists.
 */
export function staleReviewsAreEvidenceOnly(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
): boolean {
  const classification = classifyStaleApprovingReviews(reviews, preparedPackage);
  return (
    !!classification &&
    classification.evidenceOnly.length > 0 &&
    !classification.hasHeadDriftedApproval
  );
}

/**
 * Throw the standard error when the human evidence-refresh override is not
 * available (staleness is not evidence-only — reviewed code changed). Shared by
 * the ready-gate resolve path and the run.resolveDecision freshness guard so
 * both reject a stale-code override with identical semantics.
 */
export function assertEvidenceRefreshOverrideAvailable(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
): void {
  if (!staleReviewsAreEvidenceOnly(reviews, preparedPackage)) {
    throw new Error(
      'Evidence-refresh override unavailable: reviewed code changed; re-review before publishing',
    );
  }
}

/**
 * The `approve-publish-evidence-refresh` gate action when the override is
 * available for the prepared package, otherwise null. Shared by the ready-gate
 * and package-refresh action builders so the precondition and button label stay
 * defined in one place.
 */
export function buildEvidenceRefreshAction(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
): DecisionAction | null {
  if (!staleReviewsAreEvidenceOnly(reviews, preparedPackage)) {
    return null;
  }
  return {
    id: APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
    label: 'Publish Anyway (code unchanged)',
    style: 'primary',
  };
}

function reviewMatchesUnavailableSnapshotPackage(
  review: ReviewStatus,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  const certifiedSnapshotHead =
    review.reviewSnapshot?.source === 'unavailable' ? undefined : review.reviewSnapshot?.headSha;
  return (
    isQualifyingReview(review) &&
    review.verdict === 'pass' &&
    review.unresolvedCount === 0 &&
    review.reviewedHeadSha === preparedPackage.headSha &&
    review.reviewedReviewSubjectHash === preparedPackage.reviewSubjectHash &&
    (!certifiedSnapshotHead || certifiedSnapshotHead === preparedPackage.headSha)
  );
}

export function unavailableSnapshotOverrideAvailable(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewPolicy: ReviewPolicy,
): boolean {
  if (preparedPackage.reviewSnapshot?.source !== 'unavailable') return false;
  const matching = qualifyingPassingReviews(reviews).filter((review) =>
    reviewMatchesUnavailableSnapshotPackage(review, preparedPackage),
  );
  return freshPublicationReviewCountSatisfied(reviewPolicy, matching);
}

export function assertUnavailableSnapshotOverrideAvailable(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewPolicy: ReviewPolicy,
): void {
  if (!unavailableSnapshotOverrideAvailable(reviews, preparedPackage, reviewPolicy)) {
    throw new Error(
      'Snapshot-unavailable override requires passing reviews for the exact package HEAD and subject',
    );
  }
}

export function buildUnavailableSnapshotAction(
  reviews: ReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewPolicy: ReviewPolicy,
): DecisionAction | null {
  if (!unavailableSnapshotOverrideAvailable(reviews, preparedPackage, reviewPolicy)) {
    return null;
  }
  return {
    id: APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
    label: 'Publish Anyway (snapshot unavailable)',
    style: 'primary',
  };
}

function snapshotUnavailableOverrideWasApproved(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  return current.decisions.some((decision) => {
    if (decision.resolvedAction !== APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION) return false;
    const decisionPackage = (decision.payload as { prPackage?: ReadyGatePrPackage } | undefined)
      ?.prPackage;
    return decisionPackage?.packageHash === preparedPackage.packageHash;
  });
}

/**
 * Carry the prior pass verdict forward when the operator uses the human
 * evidence-refresh override: restamp every evidence-only stale approving review
 * onto the package's current subject/HEAD so the standard publication-review
 * policy reads them as fresh. Eligibility comes from the shared
 * `classifyStaleApprovingReviews`; stamping reuses
 * `stampPublishGateReviewStatusForPackage` (identical to the automatic refresh
 * path), gated behind the explicit human override.
 */
export function restampStaleApprovingReviewsForEvidenceRefresh(
  reviews: ReviewStatus[],
  approvedPackage: ReadyGatePrPackage,
): {
  reviews: ReviewStatus[];
  restampedIds: string[];
  oldReviewSubjectHashes: string[];
} {
  const restampedIds: string[] = [];
  const oldReviewSubjectHashes: string[] = [];
  const classification = classifyStaleApprovingReviews(reviews, approvedPackage);
  if (!classification) {
    return { reviews: reviews, restampedIds, oldReviewSubjectHashes };
  }
  const evidenceOnlyIds = new Set(classification.evidenceOnly.map((review) => review.id));
  const restampedReviews = reviews.map((review) => {
    if (!evidenceOnlyIds.has(review.id)) return review;
    restampedIds.push(review.id);
    oldReviewSubjectHashes.push(review.reviewedReviewSubjectHash ?? '');
    return stampPublishGateReviewStatusForPackage(review, approvedPackage);
  });
  return { reviews: restampedReviews, restampedIds, oldReviewSubjectHashes };
}

function freshPublicationReviewCountSatisfied(
  reviewPolicy: ReviewPolicy,
  reviews: ReviewStatus[],
): boolean {
  return reviewPolicySatisfied(reviewPolicy, reviews);
}

function reviewCertifiesPreparedPackage(
  review: ReviewStatus,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  if (!isQualifyingReview(review)) return false;
  if (!reviewFindingsSatisfied(review)) return false;
  return publicationReviewMatchesPreparedPackage(review, preparedPackage);
}

/** Fresh qualifying PASS reviews that certify this exact prepared package. */
export function certifyingPublicationReviews(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
  reviews: ReviewStatus[] = current.engineState?.publishGate?.reviews ?? [],
): ReviewStatus[] {
  return qualifyingPassingReviews(reviews).filter((review) =>
    reviewCertifiesPreparedPackage(review, preparedPackage),
  );
}

/**
 * ADR-062 Amendment 18: the code review checks `review` claims only when the package head
 * has no open finding and at least one certifying pass (the policy count when higher).
 * A snapshot-unavailable override approves publication; it never counts here.
 */
export function codeReviewCertifiesPackage(
  current: Run,
  preparedPackage: ReadyGatePrPackage | null | undefined,
  reviews: ReviewStatus[] = current.engineState?.publishGate?.reviews ?? [],
): boolean {
  if (!preparedPackage?.headSha || publicationReviewBlockingReason(current, preparedPackage))
    return false;
  const reviewPolicy = preparedPackage.reviewPolicy ?? publicationReviewPolicyForRun(current);
  return (
    certifyingPublicationReviews(current, preparedPackage, reviews).length >=
    Math.max(1, effectiveRequiredReviewCount(reviewPolicy))
  );
}

export function assertPublicationReviewPolicySatisfied(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
): void {
  const blocked = publicationReviewBlockingReason(current, preparedPackage);
  if (blocked) throw new Error(`Publication approval requires passing reviews: ${blocked}`);
  const reviewPolicy = preparedPackage.reviewPolicy ?? publicationReviewPolicyForRun(current);
  const reviews = current.engineState?.publishGate?.reviews ?? [];
  const freshReviews = certifyingPublicationReviews(current, preparedPackage);
  const unavailableOverrideApproved =
    snapshotUnavailableOverrideWasApproved(current, preparedPackage) &&
    unavailableSnapshotOverrideAvailable(reviews, preparedPackage, reviewPolicy);
  if (!reviewPolicySatisfied(reviewPolicy, freshReviews) && !unavailableOverrideApproved) {
    throw new Error(
      'Publication approval requires passing reviews for the approved package; package changed, refresh package and re-review before publishing',
    );
  }
}
