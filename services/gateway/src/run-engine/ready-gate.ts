import { randomUUID } from 'node:crypto';
// ready-gate.ts — Human ready/publication gate orchestration.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  effectiveRequiredReviewCount,
  type EvidenceManifestEntry,
  type EvidenceRefreshOverrideRecord,
  GATE_SUMMARY_KINDS,
  isGateParkInFlightOrFreed,
  isSlotFreedByPark,
  latestExhaustedReview,
  MachineParkEligibilityCodes,
  PipelineSteps,
  type PublicationReviewLaunchRejection,
  type ReadyGateInputSnapshot,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  reviewFixRetriesExhausted,
  type ReviewPolicy,
  reviewPolicySatisfied,
  type ReviewRequestContext,
  reviewRetryCapReason,
  reviewRetryCount,
  type ReviewSelection,
  type ReviewStatus,
  type Run,
  type RunDecision,
  stampReviewRetryCap,
} from '@farmslot/protocol';
import {
  executionModelFromSelection,
  parseReviewRequestContext,
  reviewContextFromRequest,
} from '@farmslot/review-dispatch';

import { getProjectField, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import { formatReviewMarkdown } from '../quality/review-artifacts.js';
import {
  inferReviewSourceKind,
  REQUESTED_REVIEW_SOURCE,
  REVIEW_SOURCES,
} from '../quality/review-sources.js';
import {
  executeReview as executeReviewDefault,
  type ReviewResult,
} from '../review/orchestrator.js';
import { assertReviewRoundAvailable } from '../review/review-round-budget.js';
import { reviewedInputsAwaitingReview, reviewedInputsChanged } from '../review/reviewed-inputs.js';
import { reviewPRIdentity } from '../review/session-mode.js';
import { isTerminalReviewArtifactError } from '../review/terminal-result.js';
import { assertEvidenceAttestationReceipt } from '../run-completion/evidence-attestation.js';
import {
  isArtifactOnlyRun,
  publicationStatusForRun,
  renderCurrentDescription,
  scanArtifacts,
} from '../run-completion/orchestrator.js';
import {
  readReadyGatePreparedPackage,
  readyGateCurrentDescription,
} from '../run-completion/ready-gate-package.js';
import { runnerDefaultModel } from '../runners/registry.js';
import { getRun, persistRunNow, updateRun, updateRunStep } from '../runs/store.js';
import {
  ACCEPTANCE_STATUS_FILENAME,
  acceptanceCoverageMarkdown,
  handoffCriteriaFromText,
  ledgerFromArtifactText,
} from '../tasks/acceptance-status.js';

import {
  applyBranchFreshnessToReadyGatePayload,
  type BranchFreshnessSummary,
  probeSlotBranchFreshness,
  resolveBranchUpdateStrategy,
} from './branch-freshness.js';
import {
  latestResolvedHumanGateDecision,
  markResolvedHumanGateApprovalHeld,
  markResolvedHumanGateReviewRequestConsumed,
} from './decision-replay.js';
import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { createEngineDecision } from './engine-decisions.js';
import { BlockedRunError } from './errors.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  assertEvidenceRefreshOverrideAvailable,
  assertPublicationReviewPolicySatisfied,
  assertUnavailableSnapshotOverrideAvailable,
  buildEvidenceRefreshAction,
  buildPublishGateReviewStatus,
  buildUnavailableSnapshotAction,
  countStalePublicationReviews,
  hasValidPrNumber,
  isPublishApprovalAction,
  pendingReviewContinuation as findPendingReviewContinuation,
  publicationGateDecisionActions,
  restampStaleApprovingReviewsForEvidenceRefresh,
  reviewerIsActiveForReview,
  validatePackageApprovalSelection,
} from './gate-policy.js';
import { buildGateSummary } from './gate-summary.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import {
  publicationReviewPolicyForRun,
  requiresPublicationApproval,
} from './publication-policy.js';
import {
  gateChoiceFromSelectionData,
  reconcileRunPosture,
  resolveGateChoiceOutcome,
} from './resource-posture.js';
import {
  assertReviewLaunchStateForSlot,
  publicationReviewLaunchRejectionFromError,
} from './review-launch-gate.js';
import {
  humanGateReviewPolicy,
  MAX_PUBLISH_GATE_REVIEW_LOOPS,
  reviewPlanFromSelection,
} from './review-plan.js';
import {
  getDiffStat,
  readTaskArtifactText,
  readTaskInputText,
  readWorkerReport,
} from './task-artifacts.js';

const S = PipelineSteps;

/** Task-dir relative ledger path, for the operator-facing read failure message. */
const ACCEPTANCE_STATUS_ARTIFACT_REL = `artifacts/${ACCEPTANCE_STATUS_FILENAME}`;

const activePublicationReviewContinuations = new Map<
  string,
  Promise<{ reviewId: string; verdict: ReviewResult['verdict'] } | null>
>();

function interruptedPublicationReview(run: Run): ReviewStatus | undefined {
  const activeFix = run.agentContexts?.some(
    (context) => context.role === 'review-fix' && context.status === 'working',
  );
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  const pending = findPendingReviewContinuation(reviews);
  // A gateway restart can happen after the worker fix completed and while the
  // retained reviewer is already checking the new HEAD. The persisted review
  // still carries the prior round's pending findings until that reviewer
  // finishes. Re-delivering them here races the active reviewer and sends the
  // worker stale feedback. Recovery owns the active reviewer; only resume the
  // fix when no reviewer for this review lane is running.
  if (pending) return reviewerIsActiveForReview(run, pending) ? undefined : pending;
  if (!activeFix) return undefined;
  const latest = reviews.at(-1);
  if (latest && reviewFixRetriesExhausted(latest)) return undefined;
  return latest?.verdict === 'issues' &&
    latest.unresolvedCount > 0 &&
    (latest.issues?.length ?? 0) > 0
    ? latest
    : undefined;
}

function reviewResultFromInterruptedReview(review: ReviewStatus): ReviewResult {
  return {
    verdict: 'issues',
    mode: review.mode,
    reviewId: review.id,
    reviewerSessionId: review.reviewerSessionId ?? undefined,
    session: review.session,
    issues: review.issues ?? [],
    reviewSnapshot: review.reviewSnapshot,
    fixDelta: review.fixDelta,
    attempts: review.attempts,
    validationDepth: review.validationDepth,
    usage: review.usage,
    taskProgressArtifactPath: review.taskProgressArtifactPath,
    timeline: review.timeline,
    runner: review.runner ?? undefined,
    model: review.model ?? undefined,
    effort: review.effort ?? undefined,
    retryCount: reviewRetryCount(review),
    ...(typeof review.maxRetries === 'number' ? { maxRetries: review.maxRetries } : {}),
    feedbackSent: review.feedbackSent,
    recoveryContinuationPending: review.recoveryContinuationPending,
  };
}

/**
 * Resume the fix/re-review continuation lost when the gateway restarted after
 * persisting an ISSUES verdict but before executeReview could deliver it.
 * The same review id is replaced so recovery cannot inflate review counts.
 */
export async function resumeInterruptedPublicationReview(
  runId: string,
  slotId: string,
  dependencies: { executeReview?: typeof executeReviewDefault } = {},
): Promise<{ reviewId: string; verdict: ReviewResult['verdict'] } | null> {
  const active = activePublicationReviewContinuations.get(runId);
  if (active) return active;
  const continuation = resumeInterruptedPublicationReviewOnce(runId, slotId, dependencies);
  activePublicationReviewContinuations.set(runId, continuation);
  try {
    return await continuation;
  } finally {
    if (activePublicationReviewContinuations.get(runId) === continuation) {
      activePublicationReviewContinuations.delete(runId);
    }
  }
}

async function resumeInterruptedPublicationReviewOnce(
  runId: string,
  slotId: string,
  dependencies: { executeReview?: typeof executeReviewDefault },
): Promise<{ reviewId: string; verdict: ReviewResult['verdict'] } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const interrupted = interruptedPublicationReview(run);
  if (!interrupted) return null;

  const executeReview = dependencies.executeReview ?? executeReviewDefault;
  let result: ReviewResult;
  try {
    result = await executeReview(runId, slotId, {
      reviewRunner: interrupted.runner ?? null,
      model: interrupted.model ?? null,
      effort: interrupted.effort ?? null,
      // Reviews recorded before depth existed ran the live contract; resume them as recorded.
      validationDepth: interrupted.validationDepth ?? 'full-live',
      artifactScope: interrupted.id,
      reviewId: interrupted.id,
      mode: 'warm',
      publicationReview: true,
      resumeFromResult: reviewResultFromInterruptedReview(interrupted),
    });
  } catch (error) {
    if (isTerminalReviewArtifactError(error)) throw error;
    console.warn(
      `[ready-gate] run ${runId.slice(0, 8)} — interrupted review continuation remains recoverable: ${(error as Error).message}`,
    );
    return null;
  }
  const latest = getRun(runId)!;
  const latestReviews = latest.engineState?.publishGate?.reviews ?? [];
  const reviewStatus = buildPublishGateReviewStatus({
    source: interrupted.source === 'dispatch' ? 'dispatch' : 'human-gate',
    priorReviewCount: Math.max(0, latestReviews.length - 1),
    reviewResult: result,
    requestedRunner: interrupted.runner ?? null,
    model: interrupted.model ?? latest.metrics.actualModel ?? latest.metrics.model ?? null,
    effort: result.effort ?? interrupted.effort ?? null,
    reviewId: interrupted.id,
    reviewedPackage: await readPreparedPackage(latest),
  });
  const [persisted] = await persistReviewArtifactsForRun(latest, [reviewStatus]);
  const nextReviews = latestReviews.map((review) =>
    review.id === interrupted.id ? persisted : review,
  );
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: nextReviews,
      },
    },
  });
  return { reviewId: interrupted.id, verdict: result.verdict };
}

export interface PublishGateReviewPlanResult {
  reviewIds: string[];
  rejection?: PublicationReviewLaunchRejection;
}

export interface PublishGateReviewPlanDependencies {
  assertLaunchAllowed?: (reviews: readonly ReviewStatus[], slotId: string) => Promise<void>;
  executeReview?: typeof executeReviewDefault;
  reviewSequenceContext?: ReviewRequestContext;
}

function clearPublicationReviewLaunchRejection(runId: string, rejectedAt?: string): Run {
  const latest = getRun(runId)!;
  const rejection = latest.engineState?.publishGate?.reviewLaunchRejection;
  if (!rejection || (rejectedAt && rejection.rejectedAt !== rejectedAt)) return latest;
  return updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviewLaunchRejection: undefined,
      },
    },
  });
}

function recordPublicationReviewLaunchRejection(
  runId: string,
  rejection: PublicationReviewLaunchRejection,
): void {
  const latest = getRun(runId)!;
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviewLaunchRejection: rejection,
      },
    },
  });
  updateRunStep(runId, S.HUMAN_GATE, {
    detail: `${rejection.message} ${rejection.userAction}`,
    outputs: {
      ...latest.steps.find((step) => step.name === S.HUMAN_GATE)?.outputs,
      reviewLaunchRejection: rejection,
    },
  });
}

export function reconcileReviewLaunchRejectionForCurrentHead(
  runId: string,
  headSha: string | undefined,
): PublicationReviewLaunchRejection | undefined {
  const rejection = getRun(runId)?.engineState?.publishGate?.reviewLaunchRejection;
  const rejectedHeadSha =
    rejection?.details &&
    typeof rejection.details === 'object' &&
    'currentHeadSha' in rejection.details &&
    typeof rejection.details.currentHeadSha === 'string'
      ? rejection.details.currentHeadSha
      : undefined;
  if (!rejection || !headSha) return rejection;
  if (rejection.code === 'REVIEW_ROUND_LIMIT_REACHED') return rejection;
  if (
    rejection.code === 'PUBLICATION_REVIEW_LAUNCH_REJECTED' &&
    (!rejectedHeadSha || rejectedHeadSha === headSha)
  ) {
    return rejection;
  }
  if (rejection.code === 'PUBLICATION_REVIEW_GIT_PROBE_FAILED' && rejectedHeadSha === headSha) {
    return rejection;
  }
  clearPublicationReviewLaunchRejection(runId, rejection.rejectedAt);
  return undefined;
}

export async function executePublishGateReviewPlan(
  runId: string,
  slotId: string,
  plan: ReviewSelection[],
  source: 'dispatch' | 'human-gate',
  dependencies: PublishGateReviewPlanDependencies = {},
): Promise<PublishGateReviewPlanResult> {
  const boundedPlan = plan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
  if (boundedPlan.length === 0) {
    clearPublicationReviewLaunchRejection(runId);
    return { reviewIds: [] };
  }
  const assertLaunchAllowed = dependencies.assertLaunchAllowed ?? assertReviewLaunchStateForSlot;
  const executeReview = dependencies.executeReview ?? executeReviewDefault;
  const reviewIds: string[] = [];
  const reviewSequenceContext =
    dependencies.reviewSequenceContext ??
    getRun(runId)?.engineState?.publishGate?.reviewSequenceContext;
  if (reviewSequenceContext) parseReviewRequestContext(reviewSequenceContext, boundedPlan.length);
  for (const planStep of boundedPlan) {
    const launchSnapshot = getRun(runId)!;
    try {
      await assertReviewRoundAvailable(launchSnapshot);
      await assertLaunchAllowed(launchSnapshot.engineState?.publishGate?.reviews ?? [], slotId);
    } catch (error) {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      if (!rejection) throw error;
      recordPublicationReviewLaunchRejection(runId, rejection);
      return { reviewIds, rejection };
    }
    const latestBeforeReview = clearPublicationReviewLaunchRejection(runId);
    const reviewedPackage =
      source === 'human-gate' ? await readPreparedPackage(latestBeforeReview) : undefined;
    // ID + artifact paths flow through REQUESTED_REVIEW_SOURCE so this stream stays
    // namespace-isolated from the worker's review attempts (review-sources.ts).
    const continuation = reviewSequenceContext?.reviewLineages[boundedPlan.indexOf(planStep)];
    const reviewIdentity = reviewPRIdentity(latestBeforeReview);
    if (
      planStep.mode === 'warm' &&
      continuation &&
      (!reviewIdentity ||
        continuation.repository.toLowerCase() !== reviewIdentity.repository.toLowerCase() ||
        continuation.prNumber !== reviewIdentity.prNumber)
    )
      throw new Error(
        'WARM review unavailable: the lineage context belongs to a different repository/PR',
      );
    if (planStep.mode === 'warm' && !continuation?.reviewId)
      throw new Error(
        'WARM review unavailable: this request row has no reviewId lineage context. Choose a previous review or COLD.',
      );
    const reviewId =
      planStep.mode === 'warm'
        ? continuation!.reviewId
        : REQUESTED_REVIEW_SOURCE.artifactRefs(
            (latestBeforeReview.engineState?.publishGate?.reviews ?? []).length + 1,
            `${runId}-${randomUUID()}`,
          ).id;
    const priorReview = latestBeforeReview.engineState?.publishGate?.reviews?.find(
      (review) => review.id === reviewId,
    );
    const execution = executionModelFromSelection(planStep);
    const requestedRunner = execution.runner;
    updateRunStep(runId, S.HUMAN_GATE, {
      detail: requestedRunner
        ? `Running ${source} ${requestedRunner} review (${boundedPlan.indexOf(planStep) + 1}/${boundedPlan.length})...`
        : `Running ${source} review (${boundedPlan.indexOf(planStep) + 1}/${boundedPlan.length})...`,
    });
    const validationDepth = 'static-code' as const;
    let reviewResult: ReviewResult;
    let reviewRecoveryPending = false;
    try {
      reviewResult = await executeReview(runId, slotId, {
        reviewRunner: requestedRunner,
        model: execution.model,
        effort: execution.effort,
        validationDepth,
        artifactScope: reviewId,
        reviewId,
        priorAttempts: planStep.mode === 'warm' ? priorReview?.attempts : undefined,
        publicationReview: true,
        mode: planStep.mode,
        // Configured review steps are true review loops: findings are fed back
        // to the original worker, the worker fixes them, then the same reviewer
        // re-reviews before the next configured reviewer starts.
      });
    } catch (err) {
      if (isTerminalReviewArtifactError(err)) throw err;
      const rejection = publicationReviewLaunchRejectionFromError(err);
      if (rejection) {
        recordPublicationReviewLaunchRejection(runId, rejection);
        return { reviewIds, rejection };
      }
      reviewRecoveryPending = true;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — ${source} review ${reviewId} unavailable: ${message}`,
      );
      reviewResult = {
        mode: planStep.mode,
        reviewId,
        runner: requestedRunner,
        model: planStep.model ?? undefined,
        effort: planStep.effort,
        verdict: 'blocked',
        reason: `review-unavailable: ${message}`,
        retryCount: 0,
        validationDepth,
        attempts: [
          {
            loopNumber: 1,
            mode: planStep.mode,
            verdict: 'failed',
            unresolvedCount: 0,
            reason: `review-unavailable: ${message}`,
            validationDepth,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
      };
    }
    const latest = getRun(runId)!;
    const priorReviews = latest.engineState?.publishGate?.reviews ?? [];
    const builtReviewStatus = buildPublishGateReviewStatus({
      source,
      priorReviewCount: priorReview ? priorReview.loopNumber - 1 : priorReviews.length,
      reviewResult,
      requestedRunner,
      model: reviewResult.model ?? planStep.model ?? runnerDefaultModel(requestedRunner) ?? null,
      effort: reviewResult.effort ?? planStep.effort ?? null,
      reviewId,
      reviewedPackage,
    });
    const reviewStatus = reviewRecoveryPending
      ? { ...builtReviewStatus, recoveryContinuationPending: true }
      : builtReviewStatus;
    const reviewStatuses = await persistReviewArtifactsForRun(latest, [reviewStatus]);
    reviewIds.push(...reviewStatuses.map((review) => review.id));
    updateRun(runId, {
      engineState: {
        ...latest.engineState,
        publishGate: {
          ...latest.engineState?.publishGate,
          reviews: [
            ...priorReviews.filter(
              (prior) => !reviewStatuses.some((review) => review.id === prior.id),
            ),
            ...reviewStatuses,
          ],
        },
      },
    });
    if (reviewResult.verdict !== 'pass') break;
  }
  return { reviewIds };
}
export async function persistReviewArtifactsForRun(
  run: Run,
  reviews: ReviewStatus[],
): Promise<ReviewStatus[]> {
  if (!run.taskFile || reviews.length === 0) return reviews;
  const taskDir = path.dirname(run.taskFile);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const persisted: ReviewStatus[] = [];
  for (const review of reviews) {
    // Resolve artifact paths through the ReviewSource registry so persistence
    // honors per-stream conventions instead of reconstructing from id alone.
    // If the stream's conventions ever change, only review-sources.ts moves.
    const refs = REVIEW_SOURCES[inferReviewSourceKind(review)].artifactRefs(review.loopNumber);
    const withArtifacts = {
      ...review,
      artifactPaths: [...new Set([...(review.artifactPaths ?? []), refs.jsonRel, refs.mdRel])],
    };
    await writeFile(
      path.join(taskDir, refs.jsonRel),
      JSON.stringify(withArtifacts, null, 2),
      'utf-8',
    );
    await writeFile(path.join(taskDir, refs.mdRel), formatReviewMarkdown(withArtifacts), 'utf-8');
    persisted.push(withArtifacts);
  }
  invalidateArtifactTextCache(taskDir, run.slotId);
  invalidateLiveRecipeContextMemo(run.id);
  return persisted;
}

export async function readPreparedPackage(current: Run): Promise<ReadyGatePrPackage | undefined> {
  try {
    return await readReadyGatePreparedPackage(current);
  } catch (err) {
    console.warn(
      `[run-engine] prepared package read failed for ${current.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
}

/**
 * The description approval would publish when it differs from the package's:
 * the gate shows it. A render that fails leaves the package's own on show.
 */
async function currentDescriptionForGate(
  current: Run,
  preparedPackage: ReadyGatePrPackage,
): Promise<ReadyGatePayload['currentDescription']> {
  try {
    return readyGateCurrentDescription(
      preparedPackage,
      await renderCurrentDescription(current, preparedPackage),
    );
  } catch (err) {
    console.warn(
      `[run-engine] current description render failed for ${current.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
    );
    return undefined;
  }
}

async function buildReadyGateInputSnapshot(current: Run): Promise<ReadyGateInputSnapshot> {
  let taskPrompt: string | undefined;
  if (current.taskFile) {
    try {
      taskPrompt = await readFile(current.taskFile, 'utf-8');
    } catch (err) {
      // Legacy/recycled runs can point at a task file that has already been
      // removed. The ready gate can still render ticket/input metadata, but
      // operators need the missing prompt surfaced in logs rather than hidden.
      console.warn(
        `[run-engine] ready-gate task prompt read failed for ${current.id.slice(0, 8)} at ${current.taskFile}: ${(err as Error).message}`,
      );
    }
  }

  return {
    ...(current.ticketData ? { ticketData: current.ticketData } : {}),
    taskFile: current.taskFile,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(current.engineState?.interactiveDev?.initialContext
      ? { initialContext: current.engineState.interactiveDev.initialContext }
      : {}),
    ...(current.engineState?.interactiveDev?.checklist?.length
      ? { checklist: current.engineState.interactiveDev.checklist }
      : {}),
    ...(current.templateProvenance ? { templateProvenance: current.templateProvenance } : {}),
  };
}

async function persistGateFeedback(
  current: Run,
  actionId: string,
  selectionData?: Record<string, unknown>,
): Promise<void> {
  if (!current.taskFile) return;
  const artifactsDir = path.join(path.dirname(current.taskFile), 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const rel = `artifacts/publication-gate-${actionId}-${Date.now().toString(36)}.md`;
  const instructions =
    typeof selectionData?.feedback === 'string'
      ? selectionData.feedback
      : typeof selectionData?.comment === 'string'
        ? selectionData.comment
        : '';
  await writeFile(
    path.join(path.dirname(current.taskFile), rel),
    [
      `# Publication gate action: ${actionId}`,
      '',
      instructions || 'No free-form instructions supplied.',
    ].join('\n'),
    'utf-8',
  );
  updateRun(current.id, {
    engineState: {
      ...current.engineState,
      publishGate: {
        ...current.engineState?.publishGate,
        feedbackArtifactPath: rel,
        ...(actionId === 'send-feedback' && current.engineState?.publishGate?.packageId
          ? {
              supersededPackageIds: [
                ...(current.engineState.publishGate.supersededPackageIds ?? []),
                current.engineState.publishGate.packageId,
              ],
            }
          : {}),
      },
    },
  });
}

/**
 * Human evidence-refresh publish override. Carries the prior pass verdict
 * forward onto `approvedPackage` (restamping stale-by-subject-drift approving
 * reviews) and records an audit trail on the resolved gate decision payload, so
 * the subsequent assertPublicationReviewPolicySatisfied reads the restamped
 * reviews and passes without a needless re-review. Caller has already verified
 * the override is available (subject-only drift, HEAD unchanged).
 */
async function applyEvidenceRefreshOverride(
  runId: string,
  approvedPackage: ReadyGatePrPackage,
  decision: RunDecision | undefined,
  reviewPolicy: ReviewPolicy,
  selectionData: Record<string, unknown> | undefined,
): Promise<void> {
  const before = getRun(runId)!;
  const priorReviews = before.engineState?.publishGate?.reviews ?? [];
  const { reviews, restampedIds, oldReviewSubjectHashes } =
    restampStaleApprovingReviewsForEvidenceRefresh(priorReviews, approvedPackage);
  const operator = typeof selectionData?.operator === 'string' ? selectionData.operator : null;
  const auditRecord: EvidenceRefreshOverrideRecord = {
    at: new Date().toISOString(),
    operator,
    restampedReviewIds: restampedIds,
    oldReviewSubjectHashes,
    newReviewSubjectHash: approvedPackage.reviewSubjectHash ?? '',
  };
  const decisions = decision
    ? before.decisions.map((entry) =>
        entry.id === decision.id
          ? {
              ...entry,
              payload: {
                ...(entry.payload as ReadyGatePayload),
                evidenceRefreshOverride: auditRecord,
              },
            }
          : entry,
      )
    : before.decisions;
  updateRun(runId, {
    decisions,
    engineState: {
      ...before.engineState,
      publishGate: {
        ...before.engineState?.publishGate,
        reviews: reviews,
      },
    },
  });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — evidence-refresh override restamped ${restampedIds.length} review(s) onto ${approvedPackage.id}`,
  );
}

export function localVideoProofWarning(
  evidence: Array<{ path: string }> | undefined,
): string | null {
  const paths = evidence?.map((artifact) => artifact.path.toLowerCase()) ?? [];
  if (paths.length === 0) return null;
  const hasScreenshot = paths.some((path) => /\.(png|jpe?g|gif)$/.test(path));
  const hasVideo = paths.some((path) => /\.(mp4|mov|webm)$/.test(path));
  if (!hasScreenshot || hasVideo) return null;
  return [
    '⚠️ Local video proof missing: screenshot evidence exists, but no after.mp4/.mov/.webm was packaged.',
    'Capture-helper screenshots can still prove the PR body, but add a local recipe video when you want fast post-run review without reloading the slot.',
  ].join(' ');
}

/**
 * Why a resolved publication gate must not drive the rest of the run.
 *
 * ADR-054 `free-slot`: `run.resolveDecision` restores a freed park BEFORE it
 * consumes the decision, so reaching here with a park still in flight means the
 * park landed while the engine already held a resolved decision — the race the
 * resolution path cannot see. Continuing would run FINALIZE against a stopped
 * worker and a slot another run may already own. Failing closed leaves the park
 * record, the freed slot, and the resolved decision intact for the restore that
 * the next resolution (or `machine.pause.restore`) drives, or for a cancel.
 */
export function freedSlotGateResolutionBlocker(run: Run): BlockedRunError | null {
  if (!isGateParkInFlightOrFreed(run)) return null;
  const code = isSlotFreedByPark(run)
    ? MachineParkEligibilityCodes.freedSlotRestoreRequired
    : MachineParkEligibilityCodes.gateParkInFlight;
  // BlockedRunError, not a plain Error: a plain throw makes the run terminal
  // `failed`, and cancel refuses terminal runs — which would strand the park
  // record with no way to clean it up. `blocked` keeps cancel available.
  const message =
    `Run ${run.id} is gate-parked (${code}); ` +
    'restore it into a slot before resolving the publication gate, or cancel the run';
  // Second argument is the STEP DETAIL. Without it the human-gate step records
  // the generic blocked text and the operator sees a stalled gate with no
  // reason; with it the code and the way out are on the step itself.
  return new BlockedRunError(message, `Gate park in progress (${code}); restore or cancel the run`);
}

export async function executeReadyGate(runId: string): Promise<string> {
  const current = getRun(runId)!;
  if (current.engineState?.publishGate?.humanPublicationAdoption) {
    const { assertAdoptedPublicationContinuation } =
      await import('../run-completion/human-publication.js');
    await assertAdoptedPublicationContinuation(current);
    return 'superseded-by-publication-adoption';
  }
  const artifactOnly = isArtifactOnlyRun(current);

  // Find PR + CI repo
  const pv = await loadProjectVarsOrNull(current.project, 'run step', current.id);
  const ciRepo = pv?.projectJson ? getProjectField(pv.projectJson, 'ci.repo') || null : null;
  // `??` would treat the prNumber=0 sentinel as a real value and skip rescue;
  // hasValidPrNumber filters it so findPRNumber actually runs.
  const publicationApprovalGate = requiresPublicationApproval(current);
  const preparedPackage = publicationApprovalGate ? await readPreparedPackage(current) : undefined;
  const prNumber =
    artifactOnly || publicationApprovalGate
      ? null
      : hasValidPrNumber(current)
        ? current.prNumber!
        : ciRepo
          ? await findPRNumber(current, ciRepo)
          : null;
  if (!artifactOnly && prNumber && !hasValidPrNumber(current)) {
    await persistRunPrNumber(runId, prNumber);
    await captureReviewInputArtifactsForRun(getRun(runId)!);
  }

  // Read worker report for summary
  const report = await readWorkerReport(runId);

  const workerLearnings = await readTaskArtifactText(current.taskFile, 'learnings.md');

  // Build diff stat
  // The publication package must describe the final reviewed HEAD. Earlier
  // completion snapshots remain durable history, but cannot supply this gate.
  const diffStat = await getDiffStat(current, { fresh: true });

  const videoProofWarning = localVideoProofWarning(preparedPackage?.evidenceManifest);
  // Out-of-band merge detection: if this branch already has a MERGED PR the
  // package is shipped — offer close-as-shipped instead of inviting a
  // pointless review/approve cycle that leaves the gate stranded.
  let mergedPrNumber: number | null = null;
  let branchZeroAhead = false;
  if (publicationApprovalGate && ciRepo) {
    const { findMergedPRNumber, persistRunPrNumber } =
      await import('../integrations/pr-linkage.js');
    mergedPrNumber = await findMergedPRNumber(current, ciRepo);
    if (mergedPrNumber && !current.prNumber) {
      // Persist at probe time so finalize's close-as-shipped bypass never
      // depends on a second probe succeeding.
      await persistRunPrNumber(current.id, mergedPrNumber);
    }
  }
  // defaultBranch is shared by zero-ahead + branch-freshness (single slot probe).
  const defaultBranch =
    (pv?.projectJson ? getProjectField(pv.projectJson, 'default_branch') : null) || DEFAULT_BRANCH;

  // Soft branch-freshness probe (fetch + behind/ahead + merge-tree). headSha is
  // taken from the probe when present; fall back to a cheap local rev-parse so a
  // failed/incomplete probe (timeout, missing markers) does not lose drift tracking.
  let headSha: string | undefined;
  let branchFreshness: BranchFreshnessSummary | null = null;
  if (current.slotId) {
    try {
      const vars = await loadSlotVars(current.slotId);
      const strategy = resolveBranchUpdateStrategy(pv?.projectJson);
      branchFreshness = await probeSlotBranchFreshness(vars, String(defaultBranch), strategy);
      if (branchFreshness?.headSha) headSha = branchFreshness.headSha;
      if (!headSha) {
        const r = await execOnSlot(vars, `git -C '${vars.remoteRepo}' rev-parse HEAD 2>/dev/null`, {
          timeout: 10_000,
        });
        const sha = r.stdout.trim();
        if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) headSha = sha;
      }
      // Fail closed: only promote close-as-shipped when ahead count is a known 0.
      // Unknown/missing ahead (ref not resolved) must not look like zero-ahead.
      if (
        publicationApprovalGate &&
        !mergedPrNumber &&
        branchFreshness &&
        typeof branchFreshness.aheadMain === 'number'
      ) {
        branchZeroAhead = branchFreshness.aheadMain === 0;
      }
    } catch (err) {
      console.warn(
        `[run-engine] ready-gate branch-freshness probe failed for ${runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }

  const reviewLaunchRejection = reconcileReviewLaunchRejectionForCurrentHead(runId, headSha);
  const configuredMaxRetries =
    typeof pv?.projectJson?.review?.max_retries === 'number'
      ? pv.projectJson.review.max_retries
      : undefined;
  // Re-read: `current` predates a chain of awaits and the launch-rejection
  // reconcile just above, which may have cleared `reviewLaunchRejection`.
  // Spreading the stale snapshot would write that rejection back.
  const runForRetryCap = getRun(runId)!;
  const storedReviews = runForRetryCap.engineState?.publishGate?.reviews ?? [];
  const reviews = storedReviews.map((review) => stampReviewRetryCap(review, configuredMaxRetries));
  if (
    reviews.some(
      (review, index) =>
        review.retryCount !== storedReviews[index]?.retryCount ||
        review.maxRetries !== storedReviews[index]?.maxRetries ||
        review.maxRetriesExhausted !== storedReviews[index]?.maxRetriesExhausted ||
        review.recoveryContinuationPending !== storedReviews[index]?.recoveryContinuationPending,
    )
  ) {
    updateRun(runId, {
      engineState: {
        ...runForRetryCap.engineState,
        publishGate: {
          ...runForRetryCap.engineState?.publishGate,
          reviews,
        },
      },
    });
  }
  const exhaustedReview = latestExhaustedReview(reviews);

  const baseDescription =
    publicationApprovalGate && preparedPackage
      ? [
          `**Package:** ${preparedPackage.id}`,
          `**Target:** ${preparedPackage.publicationTarget}`,
          `**Branch:** ${preparedPackage.branch || current.branch || 'unknown'}`,
          `**Files:** ${preparedPackage.diffStat.files} (+${preparedPackage.diffStat.additions} -${preparedPackage.diffStat.deletions})`,
          ...(mergedPrNumber
            ? [
                '',
                `**Already merged:** PR #${mergedPrNumber} for this branch is merged — the work has shipped. Use Close as Shipped instead of re-reviewing.`,
              ]
            : branchZeroAhead
              ? [
                  '',
                  '**Nothing to publish:** this branch has zero commits ahead of the default branch. Use Close as Shipped instead of re-reviewing.',
                ]
              : []),
          ...(exhaustedReview
            ? ['', `**Review retries exhausted:** ${reviewRetryCapReason(exhaustedReview)}`]
            : []),
          ...(videoProofWarning ? ['', videoProofWarning] : []),
          '',
          report?.slice(0, 300) ?? 'Review the local package before public PR publication.',
        ].join('\n')
      : report
        ? `**Branch:** ${current.branch ?? 'unknown'}\n**Files:** ${diffStat.files} (+${diffStat.additions} -${diffStat.deletions})\n\n${report.slice(0, 300)}`
        : `Worker finished. Branch: ${current.branch ?? 'unknown'}`;
  const desc = reviewLaunchRejection
    ? [
        baseDescription,
        '',
        `**Review launch paused:** ${reviewLaunchRejection.message}`,
        `**Next:** ${reviewLaunchRejection.userAction}`,
      ].join('\n')
    : baseDescription;

  const reviewPolicy =
    preparedPackage?.reviewPolicy ??
    publicationReviewPolicyForRun(
      current,
      pv?.projectJson,
      current.engineState?.publishGate?.reviewPolicy,
    );
  const pendingReview = findPendingReviewContinuation(reviews);
  const pendingReviewContinuation =
    pendingReview && !reviewerIsActiveForReview(current, pendingReview) ? pendingReview : undefined;
  const requiredReviewCount = effectiveRequiredReviewCount(reviewPolicy);
  const staleReviewCount =
    publicationApprovalGate && preparedPackage && requiredReviewCount > 0
      ? countStalePublicationReviews(reviews, preparedPackage)
      : 0;
  // The evidence or HEAD changed after the last passing review:
  // review must run again before publication, whatever the review minimum.
  const reviewedInputsStale = publicationApprovalGate && (await reviewedInputsChanged(current));
  const reviewSatisfied =
    !publicationApprovalGate ||
    (reviewPolicySatisfied(reviewPolicy, reviews) &&
      staleReviewCount === 0 &&
      !reviewedInputsStale);
  // The evidence-refresh override is offered ONLY when staleness is purely
  // subject/evidence drift on a still-matching HEAD — never when code changed,
  // and never when what the last review judged has changed since.
  const evidenceRefreshAction =
    publicationApprovalGate && preparedPackage && !reviewedInputsStale
      ? buildEvidenceRefreshAction(reviews, preparedPackage)
      : null;
  const unavailableSnapshotAction =
    publicationApprovalGate && preparedPackage
      ? buildUnavailableSnapshotAction(reviews, preparedPackage, reviewPolicy)
      : null;
  const actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }> =
    publicationApprovalGate
      ? publicationGateDecisionActions({
          reviewSatisfied,
          mergedPrNumber,
          branchZeroAhead,
          evidenceRefreshAction,
          unavailableSnapshotAction,
          pendingReviewContinuation,
          reviews,
          preparedPackage,
        })
      : [
          { id: 'ready', label: 'Mark Ready', style: 'primary' },
          { id: 'hold', label: 'Hold', style: 'secondary' },
        ];

  const recipeJson = await readTaskArtifactText(current.taskFile, 'recipe.json');
  // Coverage for the quality derivation: the acceptance ledger when the run kept
  // one (structure, not a hand-written table), else the worker's
  // recipe-coverage.md exactly as before (ADR-060 phase 5).
  const acceptanceLedgerText = await readTaskArtifactText(
    current.taskFile,
    ACCEPTANCE_STATUS_FILENAME,
  );
  const acceptanceStatus = ledgerFromArtifactText(acceptanceLedgerText);
  const acceptanceHandoff = handoffCriteriaFromText(
    await readTaskInputText(current.taskFile, 'handoff.json'),
  );
  // A ledger on disk that will not parse is a failure the gate must show, not an
  // empty panel: the run recorded verdicts the gateway cannot read.
  const acceptanceStatusError =
    acceptanceHandoff.error ??
    (acceptanceLedgerText?.trim() && !acceptanceStatus
      ? `invalid ${ACCEPTANCE_STATUS_ARTIFACT_REL}`
      : undefined);
  const recipeCoverage =
    acceptanceCoverageMarkdown(acceptanceStatus, acceptanceHandoff.criteria) ??
    (await readTaskArtifactText(current.taskFile, 'recipe-coverage.md'));

  // Scan artifact manifest
  let artifactManifest: EvidenceManifestEntry[] | undefined;
  if (current.taskFile) {
    try {
      const scanned = await scanArtifacts(path.dirname(current.taskFile));
      artifactManifest = scanned.map((artifact) => ({
        path: artifact.path,
        purpose: artifact.purpose,
        sizeBytes: artifact.sizeBytes,
      }));
    } catch (err) {
      // READY_GATE can still open without an artifact manifest, but operators
      // need this surfaced to diagnose missing evidence rather than accepting
      // a silent empty manifest.
      console.warn(
        `[run-engine] ready-gate artifact scan failed for ${runId.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  // Read review step output
  let reviewVerdict: string | undefined;
  let reviewSummary: string | undefined;
  const reviewStep = current.steps.find((s) => s.name === 'review');
  if (reviewStep?.outputs) {
    const out = reviewStep.outputs as Record<string, unknown>;
    reviewVerdict =
      typeof out.verdict === 'string' ? out.verdict : out.skipped ? 'skipped' : undefined;
    const issues = Array.isArray(out.issues)
      ? out.issues.filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    if (issues.length > 0) {
      reviewSummary = issues
        .map((issue) => `${String(issue.file ?? '')}: ${String(issue.description ?? '')}`)
        .join('; ');
    }
  }

  // Read ci-watch step output for inline CI status
  let ciChecks: Array<{ name: string; status: string; conclusion: string | null }> | undefined;
  const ciWatchStep = current.steps.find((s) => s.name === 'ci-watch');
  if (ciWatchStep?.outputs) {
    const out = ciWatchStep.outputs as Record<string, unknown>;
    if (!out.skipped) {
      const failed: string[] = Array.isArray(out.failedChecks)
        ? out.failedChecks.filter((name): name is string => typeof name === 'string')
        : [];
      const timeline: Array<{ status: string; detail?: string }> = Array.isArray(out.checkTimeline)
        ? out.checkTimeline.filter((entry): entry is { status: string; detail?: string } => {
            if (!entry || typeof entry !== 'object') return false;
            const record = entry as Record<string, unknown>;
            return (
              typeof record.status === 'string' &&
              (record.detail === undefined || typeof record.detail === 'string')
            );
          })
        : [];
      const lastEntry = timeline[timeline.length - 1];
      if (lastEntry?.detail) {
        // detail format: "pass: lint, tsc | fail: jest"
        const parts = lastEntry.detail.split('|').map((p: string) => p.trim());
        const checks: typeof ciChecks = [];
        for (const part of parts) {
          const [conclusion, names] = part.split(':').map((s: string) => s.trim());
          if (names) {
            for (const name of names.split(',').map((s: string) => s.trim())) {
              if (name)
                checks.push({
                  name,
                  status: 'completed',
                  conclusion: conclusion === 'pass' ? 'success' : 'failure',
                });
            }
          }
        }
        if (checks.length > 0) ciChecks = checks;
      }
      if (!ciChecks && failed.length > 0) {
        ciChecks = failed.map((name) => ({ name, status: 'completed', conclusion: 'failure' }));
      }
      if (!ciChecks && typeof out.result === 'string') {
        ciChecks = [
          {
            name: 'CI',
            status: 'completed',
            conclusion: out.result === 'pass' ? 'success' : 'failure',
          },
        ];
      }
    }
  }

  const acceptanceCriteria: string[] | undefined = current.ticketData?.acceptanceCriteria?.length
    ? current.ticketData.acceptanceCriteria
    : undefined;
  const inputSnapshot = await buildReadyGateInputSnapshot(current);
  const currentDescription = preparedPackage
    ? await currentDescriptionForGate(current, preparedPackage)
    : undefined;

  // Consolidated "what happened to reach this gate" snapshot (worker → reviews → cost).
  // Soft branch-freshness fields live on the typed ReadyGatePayload only
  // (not mirrored into the untyped gate-summary extras bag).
  const gateSummary = buildGateSummary(current, GATE_SUMMARY_KINDS.publication, {
    gatePolicy: preparedPackage?.gatePolicy,
    preparedPackage,
  });

  // Soft freshness fields go through the same clear-then-set helper as package-refresh
  // so empty mergeConflictPaths and unknown counts share one encoding.
  const readyPayload: ReadyGatePayload = applyBranchFreshnessToReadyGatePayload(
    {
      kind: 'ready',
      prNumber,
      repo: ciRepo,
      gateSummary,
      diffStat: preparedPackage?.diffStat ?? diffStat,
      workerReport: report ?? '',
      branch: preparedPackage?.branch ?? current.branch ?? '',
      slotId: current.slotId ?? undefined,
      headSha: preparedPackage?.headSha ?? headSha,
      recipeJson,
      recipeQualityArtifact: (
        await loadRecipeQualityEvaluation({
          run: current,
          workerReport: report ?? '',
          recipeJson,
          recipeCoverage,
        })
      ).artifact,
      artifactManifest: preparedPackage?.evidenceManifest ?? artifactManifest,
      reviewVerdict,
      reviewSummary,
      workerLearnings,
      reviewLaunchRejection,
      ciChecks,
      acceptanceCriteria,
      acceptanceStatus,
      ...(acceptanceStatusError ? { acceptanceStatusError } : {}),
      inputSnapshot,
      ...(preparedPackage
        ? {
            prPackage: preparedPackage,
            ...(currentDescription ? { currentDescription } : {}),
            reviewPolicy,
            reviews,
            gatePolicy: preparedPackage.gatePolicy,
            validationSummary: preparedPackage.validationSummaryPath ?? undefined,
            publicationTarget: preparedPackage.publicationTarget,
            publicationStatus: publicationStatusForRun(current),
            stale: staleReviewCount > 0,
          }
        : {}),
    },
    branchFreshness,
  );

  updateRunStep(runId, S.HUMAN_GATE, { detail: 'Waiting for operator decision' });
  // ADR-054: entering a durable operator wait. The effective retention policy
  // applies before the operator chooses; their choice then governs what follows.
  await reconcileRunPosture({ runId, boundary: 'operator-wait' });
  const actionId = await createEngineDecision(runId, 'human_gate', desc, actions, readyPayload);

  const afterDecisionRun = getRun(runId)!;
  // Bind to the latest decision matching the action we just resolved — not an
  // older review request (e.g. first loop claude when the operator just asked
  // for codex). Sort by resolvedAt so a second request-review wins.
  const decision =
    afterDecisionRun.decisions
      .filter(
        (candidate) =>
          candidate.type === 'engine_human_gate' &&
          candidate.resolvedAction === actionId &&
          !!candidate.resolvedAt,
      )
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0] ??
    latestResolvedHumanGateDecision(afterDecisionRun.decisions);
  const selectionData = decision?.selectionData;
  // BEFORE any gate-resolved effect. `run.resolveDecision` refuses to resolve a
  // gate on a parked run, so reaching this means the park landed while the
  // engine held the resolved decision (or a decision resolved earlier is being
  // replayed). Reconciling first would let `keep-for-validation` reacquire
  // capabilities on a slot another run may already own and report the worker
  // retained when the park stopped it. Blocked, not failed: `blocked` is
  // non-terminal, so the operator can still cancel the run and clear the park
  // record, which a `failed` run refuses.
  const freedSlotBlocker = freedSlotGateResolutionBlocker(getRun(runId)!);
  if (freedSlotBlocker) throw freedSlotBlocker;
  if (actionId === 'superseded-by-publication-adoption') {
    const { assertAdoptedPublicationContinuation } =
      await import('../run-completion/human-publication.js');
    await assertAdoptedPublicationContinuation(getRun(runId)!);
    return actionId;
  }
  // F42: the evidence or HEAD changed while the gate was open and
  // review has not run again for it. Hold instead of approving: the gate
  // step re-runs review and presents the gate again.
  if (
    publicationApprovalGate &&
    isPublishApprovalAction(actionId) &&
    (await reviewedInputsAwaitingReview(getRun(runId)!))
  ) {
    if (decision) {
      markResolvedHumanGateApprovalHeld(decision);
      await persistRunNow(
        updateRun(runId, { decisions: afterDecisionRun.decisions }),
        'approval held',
      );
    }
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — '${actionId}' held: evidence or HEAD changed since the last review`,
    );
    return 'hold';
  }
  // The operator's posture choice for the wait they just ended.
  const postureChoice = gateChoiceFromSelectionData(selectionData);
  const postureOutcome = await reconcileRunPosture({
    runId,
    boundary: 'gate-resolved',
    ...(postureChoice ? { gateChoice: postureChoice } : {}),
  });
  const postureResult = resolveGateChoiceOutcome(postureOutcome);
  if (postureResult.kind !== 'applied') {
    // ADR-054 defines `free-slot` as a typed rejection until the run is
    // park-eligible. The rejection and the posture actually in force are already
    // durable on the run; reconciling again to "restore" operator-wait would
    // overwrite that transition and erase the only record of the refusal. So
    // this surfaces it and leaves the persisted state alone.
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)} — posture choice '${postureChoice ?? 'default'}' ` +
        `${postureResult.kind}${'code' in postureResult && postureResult.code ? ` (${postureResult.code})` : ''}: ` +
        postureResult.reason,
    );
  }
  if (publicationApprovalGate) {
    const decisionPayload = decision?.payload as ReadyGatePayload | undefined;
    const approvedPackage = decisionPayload?.prPackage ?? preparedPackage;
    if (actionId === APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION) {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      // Re-derive availability against the decision-time package so a code change
      // between gate render and resolve cannot smuggle the override through.
      assertEvidenceRefreshOverrideAvailable(
        getRun(runId)!.engineState?.publishGate?.reviews ?? [],
        approvedPackage,
      );
      await applyEvidenceRefreshOverride(
        runId,
        approvedPackage,
        decision,
        reviewPolicy,
        selectionData,
      );
    }
    if (actionId === APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION) {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      assertUnavailableSnapshotOverrideAvailable(
        getRun(runId)!.engineState?.publishGate?.reviews ?? [],
        approvedPackage,
        reviewPolicy,
      );
    }
    if (isPublishApprovalAction(actionId)) {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      validatePackageApprovalSelection(approvedPackage, decision);
      assertEvidenceAttestationReceipt(getRun(runId)!, decision, approvedPackage);
      if (actionId !== APPROVE_PUBLISH_UNRESOLVED_ACTION) {
        assertPublicationReviewPolicySatisfied(getRun(runId)!, approvedPackage);
      }
    }
    const target =
      selectionData?.publicationTarget === 'ready'
        ? 'ready'
        : selectionData?.publicationTarget === 'draft'
          ? 'draft'
          : (approvedPackage?.publicationTarget ?? 'ready');
    const reviewRequest =
      selectionData?.reviewRequest && typeof selectionData.reviewRequest === 'object'
        ? (selectionData.reviewRequest as Record<string, unknown>)
        : {};
    const selectedPlan = reviewPlanFromSelection(selectionData);
    const requestedPlan = selectedPlan;
    const loopsToAdd = requestedPlan.length;
    const reviewRequestConsumed = markResolvedHumanGateReviewRequestConsumed(decision);
    const baseReviewPolicy = publicationReviewPolicyForRun(current, pv?.projectJson);
    const patch =
      actionId === 'request-review'
        ? {
            reviewPolicy: humanGateReviewPolicy(baseReviewPolicy, reviewRequest, {
              actionId,
              fallbackLoopCount: loopsToAdd,
            }),
            reviewSequence: requestedPlan,
            reviewSequenceContext: reviewContextFromRequest(reviewRequest),
            reviewSequenceRequestedAt: new Date().toISOString(),
          }
        : {};
    // applyEvidenceRefreshOverride persists restamped reviews + an audit record
    // earlier in this branch, so re-read instead of spreading the stale snapshot.
    const beforeFinalUpdate = getRun(runId)!;
    updateRun(runId, {
      ...(reviewRequestConsumed ? { decisions: afterDecisionRun.decisions } : {}),
      engineState: {
        ...beforeFinalUpdate.engineState,
        publishGate: {
          ...beforeFinalUpdate.engineState?.publishGate,
          gateSummary,
          publicationTarget: target,
          ...(isPublishApprovalAction(actionId)
            ? {
                approvedPackageHash: approvedPackage?.packageHash,
                approvedAt: new Date().toISOString(),
                publicationStatus: 'pending_publish' as const,
              }
            : { publicationStatus: 'not_published' as const }),
          ...patch,
        },
      },
    });
    if (!isPublishApprovalAction(actionId)) {
      await persistGateFeedback(afterDecisionRun, actionId, selectionData);
    }
  }

  // DNM removal and comment posting moved to finalize step for visibility
  console.log(`[run-engine] run ${runId.slice(0, 8)} — gate resolved: ${actionId}`);
  return actionId;
}
