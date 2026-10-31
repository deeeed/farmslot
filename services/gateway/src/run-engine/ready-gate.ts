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
  isRunArtifactImagePath,
  isSlotFreedByPark,
  latestExhaustedReview,
  MachineParkEligibilityCodes,
  PipelineSteps,
  PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES,
  type PublicationReviewLaunchRejection,
  type ReadyGateInputSnapshot,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  RECIPE_REPAIR_SCOPE_TASK_PATH,
  reviewFixRetriesExhausted,
  type ReviewPolicy,
  reviewPolicySatisfied,
  type ReviewRequestContext,
  reviewRetryCapReason,
  reviewRetryCount,
  type ReviewSelection,
  type ReviewSessionTrace,
  type ReviewStatus,
  type Run,
  type RunDecision,
  SEND_BACK_TO_AGENT_ACTION,
  stampReviewRetryCap,
} from '@farmslot/protocol';
import {
  executionModelFromSelection,
  parseReviewRequestContext,
  reviewContextFromRequest,
} from '@farmslot/review-dispatch';

import { getProjectField, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import { formatReviewMarkdown } from '../quality/review-artifacts.js';
import {
  inferReviewSourceKind,
  REQUESTED_REVIEW_SOURCE,
  REVIEW_SOURCES,
  reviewSourceKindForId,
} from '../quality/review-sources.js';
import {
  type ReviewFixSignalReader,
  settleFinishedReviewFixContext,
} from '../review/fix-settlement.js';
import {
  executeReview as executeReviewDefault,
  reReviewMode,
  type ReviewResult,
} from '../review/orchestrator.js';
import {
  assertReviewRoundAvailable,
  reviewNoVerdictCapReason,
} from '../review/review-round-budget.js';
import { reviewedInputsChanged } from '../review/reviewed-inputs.js';
import {
  assertLineageBelongsToRun,
  latestReviewOfLineage,
  reReviewOfStatus,
  reviewLineageId,
  WarmReviewRefusal,
} from '../review/session-mode.js';
import { removeSlotFiles } from '../review/snapshots.js';
import { resolveWorkerTaskDir } from '../review/templates.js';
import { isTerminalReviewArtifactError } from '../review/terminal-result.js';
import { assertEvidenceAttestationReceipt } from '../run-completion/evidence-attestation.js';
import {
  isArtifactOnlyRun,
  publicationStatusForRun,
  renderCurrentDescription,
  scanArtifacts,
} from '../run-completion/orchestrator.js';
import { rebindUnownedPublicationSlot } from '../run-completion/publication-source.js';
import {
  readReadyGatePreparedPackage,
  readyGateCurrentDescription,
} from '../run-completion/ready-gate-package.js';
import { runnerDefaultModel } from '../runners/registry.js';
import { readRunProgress } from '../runners/run-progress.js';
import { getAllRuns, getRun, persistRunNow, updateRun, updateRunStep } from '../runs/store.js';
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
  markResolvedHumanGateReviewRequestConsumed,
} from './decision-replay.js';
import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { createEngineDecision } from './engine-decisions.js';
import { BlockedRunError, OwnedWorkerBusyError } from './errors.js';
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
  CONTINUE_REVIEW_FIX_ACTION,
  countStalePublicationReviews,
  gateReviewContinuationForRun,
  hasValidPrNumber,
  isPublishApprovalAction,
  publicationGateDecisionActions,
  restampStaleApprovingReviewsForEvidenceRefresh,
  reviewerIsActiveForReview,
  validatePackageApprovalSelection,
} from './gate-policy.js';
import { buildGateSummary } from './gate-summary.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { recordPublicationApproval } from './publication-finalization.js';
import {
  publicationReviewPolicyForRun,
  requiresPublicationApproval,
} from './publication-policy.js';
import { ensureCurrentPublishPackage } from './publish-package-refresh.js';
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
  reviewLineageOptionsForRun,
  reviewPlanFromSelection,
} from './review-plan.js';
import { runSupersededSince } from './run-generation.js';
import {
  getDiffStat,
  readTaskArtifactText,
  readTaskInputText,
  readWorkerReport,
} from './task-artifacts.js';
import {
  activeVisualRepair,
  updateVisualRepair,
  visualRepairIssues,
  visualRepairOffered,
} from './visual-repair.js';

const S = PipelineSteps;

/** Task-dir relative ledger path, for the operator-facing read failure message. */
const ACCEPTANCE_STATUS_ARTIFACT_REL = `artifacts/${ACCEPTANCE_STATUS_FILENAME}`;

const activePublicationReviewContinuations = new Map<
  string,
  Promise<{ reviewId: string; verdict: ReviewResult['verdict'] } | null>
>();

async function interruptedPublicationReview(run: Run): Promise<ReviewStatus | undefined> {
  const activeFix = run.agentContexts?.some(
    (context) => context.role === 'review-fix' && context.status === 'working',
  );
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  // A gateway restart can happen after the worker fix completed and while the
  // retained reviewer is already checking the new HEAD. The persisted review
  // still carries the prior round's pending findings until that reviewer
  // finishes. Re-delivering them here races the active reviewer and sends the
  // worker stale feedback. Recovery owns the active reviewer; only resume the
  // fix when no reviewer for this review lane is running.
  const pending = await gateReviewContinuationForRun(run);
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
    reviewId: reviewLineageId(review),
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
  const interrupted = await interruptedPublicationReview(run);
  if (!interrupted) return null;

  const executeReview = dependencies.executeReview ?? executeReviewDefault;
  let result: ReviewResult;
  const resumeFromResult = reviewResultFromInterruptedReview(interrupted);
  try {
    result = await executeReview(runId, slotId, {
      reviewRunner: interrupted.runner ?? null,
      model: interrupted.model ?? null,
      effort: interrupted.effort ?? null,
      // Reviews recorded before depth existed ran the live contract; resume them as recorded.
      validationDepth: interrupted.validationDepth ?? 'full-live',
      artifactScope: interrupted.id,
      reviewId: reviewLineageId(interrupted),
      // ADR-063 Amendment 5: the fix's re-review continues this review's lineage WARM.
      mode: reReviewMode(resumeFromResult, 'cold'),
      publicationReview: true,
      resumeFromResult,
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

/**
 * Send back to agent: deliver the reserved repair through the named review loop's
 * existing fix path, then retain its result. A refusal or uncertain delivery leaves
 * the same charged repair recoverable; the caller always re-presents the gate.
 */
export async function resumeVisualRepair(
  runId: string,
  slotId: string,
  dependencies: { executeReview?: typeof executeReviewDefault } = {},
): Promise<{ repairId: string; verdict: ReviewResult['verdict'] } | null> {
  const active = activePublicationReviewContinuations.get(runId);
  if (active) return null;
  const continuation = resumeVisualRepairOnce(runId, slotId, dependencies);
  activePublicationReviewContinuations.set(runId, continuation);
  try {
    const result = await continuation;
    return result && 'repairId' in result ? result : null;
  } finally {
    if (activePublicationReviewContinuations.get(runId) === continuation) {
      activePublicationReviewContinuations.delete(runId);
    }
  }
}

async function resumeVisualRepairOnce(
  runId: string,
  slotId: string,
  dependencies: { executeReview?: typeof executeReviewDefault },
): Promise<{ reviewId: string; repairId: string; verdict: ReviewResult['verdict'] } | null> {
  const run = getRun(runId);
  const repair = run ? activeVisualRepair(run) : undefined;
  const review = run?.engineState?.publishGate?.reviews?.find(({ id }) => id === repair?.reviewId);
  if (!run || !repair || !review) return null;
  const vars = await loadSlotVars(slotId);
  const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
  if (!taskDir) {
    updateVisualRepair(runId, repair.repairId, {
      reason: 'The retained task directory is unavailable.',
    });
    return null;
  }
  const scopeFile = `${taskDir}/${RECIPE_REPAIR_SCOPE_TASK_PATH}`;
  // The worker reads the frozen scope; the run store digest remains the authority.
  await writeTextFileOnSlot(vars, scopeFile, `${JSON.stringify(repair.scope, null, 2)}\n`);
  await persistRunNow(getRun(runId)!, 'visual repair reserved');
  const executeReview = dependencies.executeReview ?? executeReviewDefault;
  let result: ReviewResult;
  try {
    result = await executeReview(runId, slotId, {
      reviewRunner: review.runner ?? null,
      model: review.model ?? null,
      effort: review.effort ?? null,
      validationDepth: review.validationDepth ?? 'full-live',
      artifactScope: review.id,
      reviewId: reviewLineageId(review),
      mode: reReviewMode(reviewResultFromInterruptedReview(review), 'cold'),
      publicationReview: true,
      resumeFromResult: {
        ...reviewResultFromInterruptedReview(review),
        verdict: 'issues',
        issues: visualRepairIssues(repair.scope, taskDir, run),
        // A retry never rolls the loop's persisted budget back.
        retryCount: Math.max(repair.reservedRetryCount, review.retryCount ?? 0),
        feedbackSent: false,
        recoveryContinuationPending: false,
      },
      reservedFixPass: {
        repairId: repair.repairId,
        onDelivered: () =>
          updateVisualRepair(runId, repair.repairId, {
            status: 'delivered',
            deliveredAt: new Date().toISOString(),
            reason: undefined,
          }),
      },
    });
  } catch (error) {
    if (isTerminalReviewArtifactError(error)) throw error;
    updateVisualRepair(runId, repair.repairId, {
      reason: `Delivery is recoverable: ${(error as Error).message}`,
    });
    return null;
  }
  const latest = getRun(runId)!;
  const latestReviews = latest.engineState?.publishGate?.reviews ?? [];
  const reviewStatus = buildPublishGateReviewStatus({
    source: review.source === 'dispatch' ? 'dispatch' : 'human-gate',
    priorReviewCount: Math.max(0, latestReviews.length - 1),
    reviewResult: result,
    requestedRunner: review.runner ?? null,
    model: review.model ?? latest.metrics.actualModel ?? latest.metrics.model ?? null,
    effort: result.effort ?? review.effort ?? null,
    reviewId: review.id,
    reviewedPackage: await readPreparedPackage(latest),
  });
  const [persisted] = await persistReviewArtifactsForRun(latest, [reviewStatus]);
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: latestReviews.map((entry) => (entry.id === review.id ? persisted : entry)),
      },
    },
  });
  if (activeVisualRepair(getRun(runId)!)?.status === 'delivered') {
    updateVisualRepair(runId, repair.repairId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    // A completed scope is retired so normal recipe runs ignore it.
    await removeSlotFiles(vars, [`${vars.remoteRepo}/${scopeFile}`]);
  } else {
    updateVisualRepair(runId, repair.repairId, {
      reason: 'The agent has not accepted the repair yet. Send back again to retry.',
    });
  }
  return { reviewId: review.id, repairId: repair.repairId, verdict: result.verdict };
}

export interface PublishGateReviewPlanResult {
  reviewIds: string[];
  rejection?: PublicationReviewLaunchRejection;
}

export interface PublishGateReviewPlanDependencies {
  assertLaunchAllowed?: typeof assertReviewLaunchStateForSlot;
  executeReview?: typeof executeReviewDefault;
  reviewSequenceContext?: ReviewRequestContext;
  /**
   * These launches are automatic, so they stop at the no-verdict cap (ADR-063
   * Amendment 2). Defaults to every source but an operator's human-gate request.
   */
  automaticLaunch?: boolean;
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
  const automaticLaunch = dependencies.automaticLaunch ?? source !== 'human-gate';
  for (const planStep of boundedPlan) {
    const launchSnapshot = getRun(runId)!;
    try {
      await assertReviewRoundAvailable(launchSnapshot);
      // Only an operator request launches past the no-verdict cap.
      const capReason = automaticLaunch
        ? await reviewNoVerdictCapReason(launchSnapshot)
        : undefined;
      if (capReason)
        throw new GatewayMethodError(
          PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.launchRejected,
          capReason,
          { userAction: 'Request a review to retry.' },
        );
      await assertLaunchAllowed(
        launchSnapshot.engineState?.publishGate?.reviews ?? [],
        slotId,
        source === 'human-gate' ? await readPreparedPackage(launchSnapshot) : undefined,
      );
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
    if (continuation) assertLineageBelongsToRun(continuation, latestBeforeReview);
    if (planStep.mode === 'warm' && !continuation?.reviewId)
      throw new Error(
        'WARM review unavailable: this request row has no reviewId lineage context. Choose a previous review or COLD.',
      );
    // ADR-063 Amendment 5: a re-review stays in its lineage, WARM or a person's COLD. The
    // lineage names the reviewer session; the row id names the gate row and its artifacts.
    const lineageId = continuation?.reviewId;
    const gateReviews = latestBeforeReview.engineState?.publishGate?.reviews ?? [];
    const priorReview = lineageId ? latestReviewOfLineage(gateReviews, lineageId) : undefined;
    const reviewId =
      priorReview?.id ??
      (lineageId && reviewSourceKindForId(lineageId)
        ? lineageId
        : REQUESTED_REVIEW_SOURCE.artifactRefs(gateReviews.length + 1, `${runId}-${randomUUID()}`)
            .id);
    // Operator and automatic re-reviews share the same session/delta fallback.
    const rereview = planStep.mode === 'warm' ? reReviewOfStatus(priorReview) : undefined;
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
        reviewId: lineageId ?? reviewId,
        priorAttempts: priorReview?.attempts,
        publicationReview: true,
        mode: planStep.mode,
        ...(rereview ? { rereview } : {}),
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
      // No session ran for this request. The row still names its lineage, and its earlier
      // attempts keep the lineage's validated result, so a later request can continue it.
      const session: ReviewSessionTrace | undefined = lineageId
        ? {
            mode: planStep.mode,
            continuity: 'refused',
            reviewId: lineageId,
            ...(err instanceof WarmReviewRefusal ? { refusalReason: err.reason } : {}),
          }
        : undefined;
      reviewResult = {
        mode: planStep.mode,
        reviewId: lineageId ?? reviewId,
        ...(session ? { session } : {}),
        runner: requestedRunner,
        model: planStep.model ?? undefined,
        effort: planStep.effort,
        verdict: 'blocked',
        reason: `review-unavailable: ${message}`,
        retryCount: 0,
        validationDepth,
        attempts: [
          ...(priorReview?.attempts ?? []),
          {
            loopNumber: (priorReview?.attempts?.at(-1)?.loopNumber ?? 0) + 1,
            mode: planStep.mode,
            ...(session ? { session } : {}),
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
  const hasScreenshot = paths.some((path) => isRunArtifactImagePath(path));
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

interface ReadyGatePackageDependencies {
  ensurePackage?: typeof ensureCurrentPublishPackage;
  createDecision?: typeof createEngineDecision;
  rebindSlot?: typeof rebindUnownedPublicationSlot;
  readReviewFixSignal?: ReviewFixSignalReader;
  readProgress?: typeof readRunProgress;
  /** Bounded wait for a busy owned worker; tests shorten it. */
  workerIdleWait?: { pollMs: number; timeoutMs: number };
}

// A compaction or a last turn finishes in minutes; past this the operator sees why.
const WORKER_IDLE_WAIT = { pollMs: 10_000, timeoutMs: 15 * 60_000 };

/**
 * Waits for the owned worker to go idle so the gate builds its own package instead of
 * leaving an "unavailable" card that only Retry Gate clears.
 */
async function waitForOwnedWorkerIdle(
  runId: string,
  generation: number,
  dependencies: ReadyGatePackageDependencies,
): Promise<'idle' | 'abort' | 'timeout'> {
  const { pollMs, timeoutMs } = dependencies.workerIdleWait ?? WORKER_IDLE_WAIT;
  const readProgress = dependencies.readProgress ?? readRunProgress;
  const deadline = Date.now() + timeoutMs;
  updateRunStep(runId, S.HUMAN_GATE, {
    detail: 'Preparing operator decision: waiting for the owned worker to be idle',
  });
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const latest = getRun(runId);
    if (
      !latest ||
      runSupersededSince(latest, generation) ||
      latest.status === 'paused' ||
      latest.status === 'cancelled'
    )
      return 'abort';
    if ((await readProgress(latest)).kind === 'idle') return 'idle';
  }
  return 'timeout';
}

export async function executeReadyGate(
  runId: string,
  dependencies: ReadyGatePackageDependencies = {},
): Promise<string> {
  let current = getRun(runId)!;
  const generation = current.engineState?.generation ?? 0;
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
  const decide = dependencies.createDecision ?? createEngineDecision;
  let preparedPackage: ReadyGatePrPackage | undefined;
  let recoveredAction: string | undefined;
  let workerIdleWaited = false;
  if (publicationApprovalGate) {
    for (;;) {
      updateRunStep(runId, S.HUMAN_GATE, {
        detail: 'Preparing operator decision: checking publication package',
      });
      // A finished fix that no resume will adopt must not read as in progress: the
      // gate's readiness would refuse the package. Settled on each pass, as Retry
      // Gate may follow the worker's finish.
      if (
        await settleFinishedReviewFixContext(runId, {
          readSignal: dependencies.readReviewFixSignal,
          adoptable: async (context) => {
            const resumable = await interruptedPublicationReview(getRun(runId)!);
            return Boolean(
              resumable && (!context.artifactScope || context.artifactScope === resumable.id),
            );
          },
        })
      )
        current = getRun(runId)!;
      try {
        // A slot can lose its owner while the run keeps the checkout (a reconcile during a
        // replay); re-bind it before the package refresh reads the publication source.
        if (await (dependencies.rebindSlot ?? rebindUnownedPublicationSlot)(getRun(runId)!))
          console.log(
            `[ready-gate] run ${runId.slice(0, 8)} — re-bound its unowned slot ${getRun(runId)?.slotId} on ${getRun(runId)?.branch}`,
          );
        preparedPackage = await (dependencies.ensurePackage ?? ensureCurrentPublishPackage)(runId);
        break;
      } catch (error) {
        if (error instanceof OwnedWorkerBusyError && !workerIdleWaited) {
          // Once per gate pass: a worker still busy after the bounded wait gets the card below.
          workerIdleWaited = true;
          const waited = await waitForOwnedWorkerIdle(runId, generation, dependencies);
          if (waited === 'abort') return 'abort';
          if (waited === 'idle') {
            current = getRun(runId)!;
            continue;
          }
        }
        // Unavailable source is a durable operator wait, never permission to fail
        // the run and tear down its retained worker, slot or proof.
        const message = `Publication package is unavailable: ${error instanceof Error ? error.message : String(error)}. Restore the owned source and retry this gate.`;
        // Fix delivery must remain reachable when its own CI receipt blocks
        // packaging. It regenerates the role checklist through the existing owner.
        const fixActions = publicationGateDecisionActions({
          reviewSatisfied: false,
          pendingReviewContinuation: await interruptedPublicationReview(getRun(runId)!),
          visualRepairReviewId: activeVisualRepair(getRun(runId)!)?.reviewId,
        }).filter((action) => action.id === CONTINUE_REVIEW_FIX_ACTION);
        recoveredAction = await decide(
          runId,
          'human_gate',
          message,
          [...fixActions, { id: 'hold', label: 'Retry Gate', style: 'secondary' }],
          {
            kind: 'ready',
            prNumber: null,
            repo: ciRepo,
            branch: current.branch ?? '',
            workerReport: message,
            diffStat: { files: 0, additions: 0, deletions: 0 },
            stale: true,
          },
          { canReplay: () => false },
        );
        // Keep the live resolution instead of replaying a cached action. Some
        // explicit actions, including Continue Fixing, intentionally never replay.
        const latest = getRun(runId);
        if (
          recoveredAction === 'abort' ||
          runSupersededSince(latest, generation) ||
          latest!.status === 'paused' ||
          latest!.status === 'cancelled'
        )
          return 'abort';
        if (recoveredAction === CONTINUE_REVIEW_FIX_ACTION) return recoveredAction;
        current = latest!;
        workerIdleWaited = false; // a Retry Gate waits for a busy worker again
      }
    }
    const approved = getRun(runId)!;
    const approval = latestResolvedHumanGateDecision(approved.decisions);
    if (
      approved.engineState?.publishGate?.publicationStatus === 'pending_publish' &&
      approved.engineState.publishGate.approvedPackageHash === preparedPackage?.packageHash &&
      approval?.payload?.kind === 'ready' &&
      approval.payload.prPackage?.packageHash === preparedPackage?.packageHash &&
      isPublishApprovalAction(approval.resolvedAction)
    )
      recoveredAction = approval.resolvedAction;
  }
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

  const workerLearnings = await readTaskArtifactText(current, 'learnings.md');

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
  const pendingReview = await gateReviewContinuationForRun(
    getRun(runId)!,
    preparedPackage?.headSha,
  );
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
          sendBackToAgent: await visualRepairOffered(getRun(runId)!, preparedPackage),
          visualRepairReviewId: activeVisualRepair(getRun(runId)!)?.reviewId,
          reviews,
          preparedPackage,
        })
      : [
          { id: 'ready', label: 'Mark Ready', style: 'primary' },
          { id: 'hold', label: 'Hold', style: 'secondary' },
        ];

  const recipeJson = await readTaskArtifactText(current, 'recipe.json');
  // Coverage is rendered from the engine ledger. Worker prose cannot replace it.
  const acceptanceLedgerText = await readTaskArtifactText(current, ACCEPTANCE_STATUS_FILENAME);
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
  const recipeCoverage = acceptanceCoverageMarkdown(acceptanceStatus, acceptanceHandoff.criteria);

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

  // ADR-063 Amendment 5: Request Review preselects the lineages it can continue.
  const reviewLineageOptions = await reviewLineageOptionsForRun(
    getRun(runId)!,
    getAllRuns(),
    preparedPackage?.headSha ?? headSha,
    async (ancestor, head) => {
      if (!current.slotId) throw new Error('the run has no slot to compare the reviewed head on');
      const vars = await loadSlotVars(current.slotId);
      const result = await execOnSlot(
        vars,
        `git merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(head)}`,
        { timeout: 10_000 },
      );
      return result.exitCode === 0;
    },
  );

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
      reviewLineageOptions,
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

  updateRunStep(runId, S.HUMAN_GATE, {
    detail: 'Preparing operator decision: reconciling workspace',
  });
  // ADR-054: entering a durable operator wait. The effective retention policy
  // applies before the operator chooses; their choice then governs what follows.
  await reconcileRunPosture({ runId, boundary: 'operator-wait' });
  const resolved = latestResolvedHumanGateDecision(getRun(runId)!.decisions);
  if (
    recoveredAction &&
    isPublishApprovalAction(recoveredAction) &&
    (resolved?.payload?.kind !== 'ready' ||
      resolved.payload.prPackage?.packageHash !== preparedPackage?.packageHash)
  ) {
    recoveredAction = undefined;
  }
  if (runSupersededSince(getRun(runId), generation)) return 'abort';
  const actionId =
    recoveredAction ??
    (await decide(runId, 'human_gate', desc, actions, readyPayload, {
      canReplay: (prior) =>
        !isPublishApprovalAction(prior.resolvedAction ?? '') ||
        (prior.payload?.kind === 'ready' &&
          prior.payload.prPackage?.packageHash === preparedPackage?.packageHash),
    }));

  if (actionId === 'abort' || runSupersededSince(getRun(runId), generation)) return 'abort';
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
  // Resolve validates reviewed inputs before consuming an approval. Finalize
  // revalidates them before publication. Never turn an accepted approval into
  // an implicit hold or a new review/fix loop here.
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
      if (!decision) throw new Error('Publication approval decision is unavailable');
      recordPublicationApproval(runId, approvedPackage, decision);
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
          ...(!isPublishApprovalAction(actionId)
            ? { publicationStatus: 'not_published' as const }
            : {}),
          ...patch,
        },
      },
    });
    // Send back is delivered by the retained review loop; a feedback note is not delivery.
    if (!isPublishApprovalAction(actionId) && actionId !== SEND_BACK_TO_AGENT_ACTION) {
      await persistGateFeedback(afterDecisionRun, actionId, selectionData);
    }
  }

  // DNM removal and comment posting moved to finalize step for visibility
  console.log(`[run-engine] run ${runId.slice(0, 8)} — gate resolved: ${actionId}`);
  return actionId;
}
