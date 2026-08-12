import type {
  DecisionAction,
  EvidenceManifestEntry,
  IndependentReviewAttempt,
  IndependentReviewStatus,
  NoChangeGatePayload,
  ReadyGatePrPackage,
  ReviewDepthPolicy,
  ReviewDiffSnapshot,
  Run,
  RunDecision,
  WorkerTerminalDisposition,
  WorkerTerminalEvidence,
} from '@farmslot/protocol';

import {
  effectiveRequiredReviewCount,
  independentReviewPolicySatisfied,
  isQualifyingIndependentReview,
} from '../quality/review-policy.js';
import { EXTRA_REVIEW_SOURCE, reviewLoopNumberFromId } from '../quality/review-sources.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import { normalizeRunner } from '../runners/registry.js';
import type { SelfReviewResult } from '../self-review/orchestrator.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { publicationReviewPolicyForRun } from './publication-policy.js';

/**
 * Human override action surfaced on the publish gate when staleness is caused
 * purely by evidence/subject drift while the reviewed HEAD still matches the
 * prepared package. Carries the prior pass verdict forward instead of forcing a
 * needless re-review. Never offered when the reviewed code actually changed.
 */
export const APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION = 'approve-publish-evidence-refresh';

/** Explicit human escape when the slot disappeared before its diff snapshot could be recaptured. */
export const APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION = 'approve-publish-snapshot-unavailable';

/**
 * Gate action offered when the run's branch already shipped out-of-band (merged
 * PR, or zero commits ahead of the default branch). Resolving it links the
 * merged PR when discoverable and completes the run without re-publishing.
 */
export const CLOSE_AS_SHIPPED_ACTION = 'close-as-shipped';

/** Continue the latest issues review from its persisted findings. */
export const CONTINUE_REVIEW_FIX_ACTION = 'continue-review-fix';

/**
 * Action ids that approve a local-first publication at the human ready/publish
 * gate. Shared so the engine loop exit, finalize guard, decision replay, and the
 * resolve freshness check all recognize the same set rather than scattering
 * string literals that drift apart.
 */
export const PUBLISH_APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  'approve-publish',
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  'ready',
]);

export function isPublishApprovalAction(actionId: string | null | undefined): boolean {
  return PUBLISH_APPROVAL_ACTIONS.has(actionId ?? '');
}

export function independentReviewNeedsContinuation(
  review: Pick<
    IndependentReviewStatus,
    | 'source'
    | 'verdict'
    | 'feedbackSent'
    | 'recoveryContinuationPending'
    | 'unresolvedCount'
    | 'issues'
  >,
): boolean {
  return (
    review.source !== 'self-review' &&
    review.verdict === 'issues' &&
    review.feedbackSent !== true &&
    review.recoveryContinuationPending === true &&
    review.unresolvedCount > 0 &&
    (review.issues?.length ?? 0) > 0
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
export function normalizeExhaustedReviewContinuation(
  review: IndependentReviewStatus,
): IndependentReviewStatus {
  const finalAttempt = review.attempts?.at(-1);
  if (
    review.source === 'self-review' ||
    review.verdict !== 'issues' ||
    review.unresolvedCount <= 0 ||
    (review.issues?.length ?? 0) === 0 ||
    review.feedbackSent !== true ||
    review.recoveryContinuationPending === true ||
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
export function pendingIndependentReviewContinuation(
  reviews: readonly IndependentReviewStatus[],
): IndependentReviewStatus | undefined {
  const latest = [...reviews].reverse().find((review) => review.source !== 'self-review');
  return latest && independentReviewNeedsContinuation(latest) ? latest : undefined;
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
  workerRunner,
  model,
  reviewId,
  reviewedPackage,
}: {
  source: 'dispatch' | 'human-gate';
  priorReviewCount: number;
  reviewResult: SelfReviewResult;
  requestedRunner: string | null;
  workerRunner?: string | null;
  model?: string | null;
  reviewId?: string;
  reviewedPackage?: Pick<
    ReadyGatePrPackage,
    'headSha' | 'packageInputHash' | 'reviewSubjectHash'
  > | null;
}): IndependentReviewStatus {
  const attempts: IndependentReviewAttempt[] =
    Array.isArray(reviewResult.attempts) && reviewResult.attempts.length
      ? reviewResult.attempts
      : [
          {
            loopNumber: 1,
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
  const reviewRunner = reviewResult.runner ?? requestedRunner ?? workerRunner ?? null;
  const resolvedReviewId = reviewId ?? EXTRA_REVIEW_SOURCE.artifactRefs(priorReviewCount + 1).id;
  const status: IndependentReviewStatus = {
    id: resolvedReviewId,
    source,
    runner: reviewRunner,
    model: reviewResult.model ?? model ?? null,
    reviewerSessionId:
      finalAttempt.usage?.runnerSessionId ?? reviewResult.usage?.runnerSessionId ?? null,
    crossRunner:
      reviewResult.crossRunner === true ||
      (!!requestedRunner && requestedRunner !== normalizeRunner(workerRunner)),
    loopNumber:
      reviewLoopNumberFromId(EXTRA_REVIEW_SOURCE, resolvedReviewId) ?? priorReviewCount + 1,
    verdict: finalAttempt.verdict,
    unresolvedCount: finalAttempt.unresolvedCount,
    reason: finalAttempt.reason ?? reviewResult.reason,
    issues:
      finalAttempt.issues ?? (finalAttempt.unresolvedCount > 0 ? reviewResult.issues : undefined),
    validationDepth: finalAttempt.validationDepth ?? reviewResult.validationDepth,
    usage: finalAttempt.usage ?? reviewResult.usage,
    feedbackSent: reviewResult.feedbackSent === true,
    recoveryContinuationPending: reviewResult.recoveryContinuationPending === true,
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
  if (!reviewedPackage) return status;
  const finalReviewedHeadSha = status.reviewSnapshot?.headSha ?? null;
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
    return status;
  }
  return stampPublishGateReviewStatusForPackage(status, reviewedPackage);
}

export function stampPublishGateReviewStatusForPackage(
  review: IndependentReviewStatus,
  reviewedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'packageInputHash' | 'reviewSubjectHash'>,
): IndependentReviewStatus {
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

/**
 * A gateway restart kills the engine loop that owned a pending human-gate
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
    if (decision.type !== 'engine_human_gate' || decision.resolvedAt) continue;
    decision.resolvedAt = nowIso;
    decision.resolvedAction = 'superseded';
    decision.context = { ...decision.context, supersededBy: 'gate-reentry' };
    superseded += 1;
  }
  return superseded;
}

export function validatePackageApprovalSelection(
  preparedPackage: ReadyGatePrPackage,
  decision: RunDecision | undefined,
): void {
  const refreshGuidance =
    preparedPackage.reviewDepth && effectiveRequiredReviewCount(preparedPackage.reviewDepth) === 0
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
}

function canonicalEvidenceSelectionForPackage(
  preparedPackage: ReadyGatePrPackage,
  keys: readonly string[] | undefined,
): string[] {
  const manifest = preparedPackage.evidenceManifest ?? [];
  const resolve = (key: string): string => {
    const exact = manifest.find((artifact) => artifact.path === key);
    if (exact) return exact.path;
    const selectedVariants = new Set(evidenceKeyVariants(key));
    const matches = manifest.filter((artifact) =>
      evidenceKeyVariants(artifact.path).some((variant) => selectedVariants.has(variant)),
    );
    return matches.length === 1 ? matches[0].path : key;
  };
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
  review: IndependentReviewStatus,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot'>,
): boolean {
  if (review.verdict !== 'pass' || review.unresolvedCount !== 0) return false;
  const snapshot = review.reviewSnapshot;
  if (!snapshot || snapshot.source === 'unavailable') return false;
  if (!preparedPackage.headSha || snapshot.headSha !== preparedPackage.headSha) return false;
  return reviewSnapshotDiffMatchesPackage(snapshot, preparedPackage);
}

function reviewSnapshotDiffMatchesPackage(
  snapshot: ReviewDiffSnapshot,
  preparedPackage: Pick<ReadyGatePrPackage, 'reviewSnapshot'>,
): boolean {
  const preparedSnapshot = preparedPackage.reviewSnapshot;
  if (!preparedSnapshot || preparedSnapshot.source === 'unavailable') return false;
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
  review: IndependentReviewStatus,
  packageReviewSubjectHash: string,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot'>,
): PublicationReviewStaleness {
  const snapshot = review.reviewSnapshot;
  const reviewedHeadSha = review.reviewedHeadSha ?? snapshot?.headSha ?? null;
  const reviewedSubjectHash = review.reviewedReviewSubjectHash ?? null;
  const subjectDrift = reviewedSubjectHash !== packageReviewSubjectHash;
  const diffDrift = !snapshot || !reviewSnapshotDiffMatchesPackage(snapshot, preparedPackage);
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
  review: IndependentReviewStatus,
  preparedPackage: Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot' | 'reviewSubjectHash'>,
): boolean {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return false;
  return !diagnosePublicationReviewStaleness(review, packageReviewSubjectHash, preparedPackage)
    .stale;
}

export function countStalePublicationReviews(
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  options?: { requireCrossRunnerCertification?: boolean },
): number {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash)
    return independentReviews.filter(isQualifyingIndependentReview).length;
  const reviewDepth = {
    minimumIndependentReviews: preparedPackage.reviewDepth?.minimumIndependentReviews ?? 1,
    requireCrossRunner: Boolean(
      preparedPackage.reviewDepth?.requireCrossRunner || options?.requireCrossRunnerCertification,
    ),
    extraLoopsRequested: preparedPackage.reviewDepth?.extraLoopsRequested ?? 0,
    requestedBy: preparedPackage.reviewDepth?.requestedBy ?? 'dispatch',
  };
  const freshReviews = independentReviews.filter((review) =>
    reviewCertifiesPreparedPackage(review, preparedPackage),
  );
  if (freshPublicationReviewCountSatisfied(reviewDepth, freshReviews)) return 0;
  const certifiedByFreshFixLoop = independentReviews.some(
    (review) =>
      reviewCertifiesApprovedHeadAfterFix(review, preparedPackage) &&
      (!options?.requireCrossRunnerCertification || review.crossRunner),
  );
  return independentReviews.filter(
    (review) =>
      isQualifyingIndependentReview(review) &&
      diagnosePublicationReviewStaleness(review, packageReviewSubjectHash, preparedPackage).stale &&
      !certifiedByFreshFixLoop,
  ).length;
}

interface StaleApprovalClassification {
  /** Stale approving reviews caused purely by subject/evidence drift (HEAD unchanged). */
  evidenceOnly: IndependentReviewStatus[];
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
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  options?: { requireCrossRunnerCertification?: boolean },
): StaleApprovalClassification | null {
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return null;
  const evidenceOnly: IndependentReviewStatus[] = [];
  let hasHeadDriftedApproval = false;
  for (const review of independentReviews) {
    if (!isQualifyingIndependentReview(review)) continue;
    if (review.verdict !== 'pass' || review.unresolvedCount !== 0) continue;
    if (options?.requireCrossRunnerCertification && !review.crossRunner) continue;
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
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  options?: { requireCrossRunnerCertification?: boolean },
): boolean {
  const classification = classifyStaleApprovingReviews(
    independentReviews,
    preparedPackage,
    options,
  );
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
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewDepth: ReviewDepthPolicy,
): void {
  if (
    !staleReviewsAreEvidenceOnly(independentReviews, preparedPackage, {
      requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
    })
  ) {
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
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewDepth: ReviewDepthPolicy,
): DecisionAction | null {
  if (
    !staleReviewsAreEvidenceOnly(independentReviews, preparedPackage, {
      requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
    })
  ) {
    return null;
  }
  return {
    id: APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
    label: 'Publish Anyway (code unchanged)',
    style: 'primary',
  };
}

function reviewMatchesUnavailableSnapshotPackage(
  review: IndependentReviewStatus,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  const certifiedSnapshotHead =
    review.reviewSnapshot?.source === 'unavailable' ? undefined : review.reviewSnapshot?.headSha;
  return (
    isQualifyingIndependentReview(review) &&
    review.verdict === 'pass' &&
    review.unresolvedCount === 0 &&
    review.reviewedHeadSha === preparedPackage.headSha &&
    review.reviewedReviewSubjectHash === preparedPackage.reviewSubjectHash &&
    (!certifiedSnapshotHead || certifiedSnapshotHead === preparedPackage.headSha)
  );
}

export function unavailableSnapshotOverrideAvailable(
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewDepth: ReviewDepthPolicy,
): boolean {
  if (preparedPackage.reviewSnapshot?.source !== 'unavailable') return false;
  const matching = independentReviews.filter((review) =>
    reviewMatchesUnavailableSnapshotPackage(review, preparedPackage),
  );
  return freshPublicationReviewCountSatisfied(reviewDepth, matching);
}

export function assertUnavailableSnapshotOverrideAvailable(
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewDepth: ReviewDepthPolicy,
): void {
  if (!unavailableSnapshotOverrideAvailable(independentReviews, preparedPackage, reviewDepth)) {
    throw new Error(
      'Snapshot-unavailable override requires passing reviews for the exact package HEAD and subject',
    );
  }
}

export function buildUnavailableSnapshotAction(
  independentReviews: IndependentReviewStatus[],
  preparedPackage: ReadyGatePrPackage,
  reviewDepth: ReviewDepthPolicy,
): DecisionAction | null {
  if (!unavailableSnapshotOverrideAvailable(independentReviews, preparedPackage, reviewDepth)) {
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
  independentReviews: IndependentReviewStatus[],
  approvedPackage: ReadyGatePrPackage,
  options?: { requireCrossRunnerCertification?: boolean },
): {
  reviews: IndependentReviewStatus[];
  restampedIds: string[];
  oldReviewSubjectHashes: string[];
} {
  const restampedIds: string[] = [];
  const oldReviewSubjectHashes: string[] = [];
  const classification = classifyStaleApprovingReviews(
    independentReviews,
    approvedPackage,
    options,
  );
  if (!classification) {
    return { reviews: independentReviews, restampedIds, oldReviewSubjectHashes };
  }
  const evidenceOnlyIds = new Set(classification.evidenceOnly.map((review) => review.id));
  const reviews = independentReviews.map((review) => {
    if (!evidenceOnlyIds.has(review.id)) return review;
    restampedIds.push(review.id);
    oldReviewSubjectHashes.push(review.reviewedReviewSubjectHash ?? '');
    return stampPublishGateReviewStatusForPackage(review, approvedPackage);
  });
  return { reviews, restampedIds, oldReviewSubjectHashes };
}

function freshPublicationReviewCountSatisfied(
  reviewDepth: ReviewDepthPolicy,
  reviews: IndependentReviewStatus[],
): boolean {
  const required = effectiveRequiredReviewCount(reviewDepth);
  if (required === 0) return true;
  const passing = reviews.filter(
    (review) =>
      isQualifyingIndependentReview(review) &&
      review.verdict === 'pass' &&
      review.unresolvedCount === 0,
  );
  if (passing.length < required) return false;
  if (reviewDepth.requireCrossRunner && !passing.some((review) => review.crossRunner)) return false;
  return true;
}

function reviewCertifiesPreparedPackage(
  review: IndependentReviewStatus,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  if (!isQualifyingIndependentReview(review)) return false;
  if (review.verdict !== 'pass' || review.unresolvedCount !== 0) return false;
  return publicationReviewMatchesPreparedPackage(review, preparedPackage);
}

export function assertPublicationReviewPolicySatisfied(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
): void {
  const reviewDepth = preparedPackage.reviewDepth ?? publicationReviewPolicyForRun(current);
  const independentReviews = current.engineState?.publishGate?.independentReviews ?? [];
  const requiredReviewCount = effectiveRequiredReviewCount(reviewDepth);
  const staleReviewCount =
    requiredReviewCount > 0
      ? countStalePublicationReviews(independentReviews, preparedPackage, {
          requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
        })
      : 0;
  const unavailableOverrideApproved =
    snapshotUnavailableOverrideWasApproved(current, preparedPackage) &&
    unavailableSnapshotOverrideAvailable(independentReviews, preparedPackage, reviewDepth);
  if (
    !independentReviewPolicySatisfied(reviewDepth, independentReviews) ||
    (staleReviewCount > 0 && !unavailableOverrideApproved)
  ) {
    throw new Error(
      'Publication approval requires passing independent reviews for the approved package; package changed, refresh package and re-review before publishing',
    );
  }
}

function reviewCertifiesApprovedHeadAfterFix(
  review: IndependentReviewStatus,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  if (!preparedPackage.headSha) return false;
  if (!isQualifyingIndependentReview(review)) return false;
  if (review.verdict !== 'pass' || review.unresolvedCount !== 0) return false;
  const snapshot = review.reviewSnapshot;
  if (
    !snapshot ||
    snapshot.source === 'unavailable' ||
    snapshot.headSha !== preparedPackage.headSha
  )
    return false;
  const packageReviewSubjectHash = preparedPackage.reviewSubjectHash?.trim();
  if (!packageReviewSubjectHash) return false;
  if (review.reviewedReviewSubjectHash !== packageReviewSubjectHash) return false;
  return reviewHasWorkerFixLoop(review);
}

function reviewHasWorkerFixLoop(review: IndependentReviewStatus): boolean {
  if (review.feedbackSent) return true;
  if (review.timeline?.some((segment) => segment.kind === 'worker-fix')) return true;
  const attempts = review.attempts ?? [];
  if (attempts.some((attempt) => attempt.fixDelta)) return true;
  const sawIssues = attempts.some(
    (attempt) => attempt.verdict === 'issues' && attempt.unresolvedCount > 0,
  );
  const sawPass = attempts.some(
    (attempt) => attempt.verdict === 'pass' && attempt.unresolvedCount === 0,
  );
  return sawIssues && sawPass;
}
