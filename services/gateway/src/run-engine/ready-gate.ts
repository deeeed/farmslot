// ready-gate.ts — Human ready/publication gate orchestration.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvidenceManifestEntry,
  type EvidenceRefreshOverrideRecord,
  GATE_SUMMARY_KINDS,
  type IndependentReviewStatus,
  isGateParkInFlightOrFreed,
  isSlotFreedByPark,
  MachineParkEligibilityCodes,
  PipelineSteps,
  type PublicationReviewLaunchRejection,
  type ReadyGateInputSnapshot,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type ReviewDepthPolicy,
  type ReviewLoopRequest,
  reviewValidationDepthForLoop,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { getProjectField, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { findPRNumber, persistRunPrNumber } from '../integrations/pr-linkage.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { formatIndependentReviewMarkdown } from '../quality/independent-review-artifacts.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';
import {
  effectiveRequiredReviewCount,
  independentReviewPolicySatisfied,
} from '../quality/review-policy.js';
import {
  EXTRA_REVIEW_SOURCE,
  inferReviewSourceKind,
  REVIEW_SOURCES,
} from '../quality/review-sources.js';
import {
  isArtifactOnlyRun,
  publicationStatusForRun,
  scanArtifacts,
} from '../run-completion/orchestrator.js';
import { readReadyGatePreparedPackage } from '../run-completion/ready-gate-package.js';
import { defaultAlternateReviewRunner, runnerDefaultModel } from '../runners/registry.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { executeSelfReview, type SelfReviewResult } from '../self-review/orchestrator.js';
import { isTerminalReviewArtifactError } from '../self-review/terminal-result.js';

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
import { BlockedRunError } from './errors.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  assertEvidenceRefreshOverrideAvailable,
  assertPublicationReviewPolicySatisfied,
  assertUnavailableSnapshotOverrideAvailable,
  buildEvidenceRefreshAction,
  buildPublishGateReviewStatus,
  buildUnavailableSnapshotAction,
  CLOSE_AS_SHIPPED_ACTION,
  CONTINUE_REVIEW_FIX_ACTION,
  countStalePublicationReviews,
  hasValidPrNumber,
  isPublishApprovalAction,
  pendingIndependentReviewContinuation,
  restampStaleApprovingReviewsForEvidenceRefresh,
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
  assertIndependentReviewLaunchStateForSlot,
  publicationReviewLaunchRejectionFromError,
} from './review-launch-gate.js';
import {
  effectiveReviewRunner,
  humanGateReviewDepth,
  MAX_PUBLISH_GATE_REVIEW_LOOPS,
  requestedReviewLoopCount,
  reviewPlanFromSelection,
} from './review-plan.js';
import { getDiffStat, readTaskArtifactText, readWorkerReport } from './task-artifacts.js';

const S = PipelineSteps;

const activePublicationReviewContinuations = new Map<
  string,
  Promise<{ reviewId: string; verdict: SelfReviewResult['verdict'] } | null>
>();

function reviewerIsActiveForReview(run: Run, review: IndependentReviewStatus): boolean {
  return (run.agentContexts ?? []).some(
    (context) =>
      context.role === 'self-review' &&
      ['launching', 'working', 'waiting'].includes(context.status) &&
      context.artifactScope === review.id,
  );
}

function interruptedPublicationReview(run: Run): IndependentReviewStatus | undefined {
  const activeFix = run.agentContexts?.some(
    (context) => context.role === 'self-review-fix' && context.status === 'working',
  );
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  const pending = pendingIndependentReviewContinuation(reviews);
  // A gateway restart can happen after the worker fix completed and while the
  // retained reviewer is already checking the new HEAD. The persisted review
  // still carries the prior round's pending findings until that reviewer
  // finishes. Re-delivering them here races the active reviewer and sends the
  // worker stale feedback. Recovery owns the active reviewer; only resume the
  // fix when no reviewer for this review lane is running.
  if (pending) return reviewerIsActiveForReview(run, pending) ? undefined : pending;
  if (!activeFix) return undefined;
  const latest = [...reviews].reverse().find((review) => review.source !== 'self-review');
  return latest?.verdict === 'issues' &&
    latest.unresolvedCount > 0 &&
    (latest.issues?.length ?? 0) > 0
    ? latest
    : undefined;
}

function selfReviewResultFromInterruptedReview(review: IndependentReviewStatus): SelfReviewResult {
  return {
    verdict: 'issues',
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
    crossRunner: review.crossRunner,
    retryCount: Math.max(0, (review.attempts?.length ?? 1) - 1),
    feedbackSent: review.feedbackSent,
    recoveryContinuationPending: review.recoveryContinuationPending,
  };
}

/**
 * Resume the fix/re-review continuation lost when the gateway restarted after
 * persisting an ISSUES verdict but before executeSelfReview could deliver it.
 * The same review id is replaced so recovery cannot inflate review counts.
 */
export async function resumeInterruptedPublicationReview(
  runId: string,
  slotId: string,
  dependencies: { executeReview?: typeof executeSelfReview } = {},
): Promise<{ reviewId: string; verdict: SelfReviewResult['verdict'] } | null> {
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
  dependencies: { executeReview?: typeof executeSelfReview },
): Promise<{ reviewId: string; verdict: SelfReviewResult['verdict'] } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const interrupted = interruptedPublicationReview(run);
  if (!interrupted) return null;

  const executeReview = dependencies.executeReview ?? executeSelfReview;
  let result: SelfReviewResult;
  try {
    result = await executeReview(runId, slotId, {
      reviewRunner: interrupted.runner ?? null,
      model: interrupted.model ?? null,
      validationDepth: interrupted.validationDepth ?? null,
      artifactScope: interrupted.id,
      publicationReview: true,
      resumeFromResult: selfReviewResultFromInterruptedReview(interrupted),
    });
  } catch (error) {
    if (isTerminalReviewArtifactError(error)) throw error;
    console.warn(
      `[ready-gate] run ${runId.slice(0, 8)} — interrupted review continuation remains recoverable: ${(error as Error).message}`,
    );
    return null;
  }
  const latest = getRun(runId)!;
  const latestReviews = latest.engineState?.publishGate?.independentReviews ?? [];
  const reviewStatus = buildPublishGateReviewStatus({
    source: interrupted.source === 'dispatch' ? 'dispatch' : 'human-gate',
    priorReviewCount: Math.max(0, latestReviews.length - 1),
    reviewResult: result,
    requestedRunner: interrupted.runner ?? null,
    workerRunner: latest.metrics.runner,
    model: interrupted.model ?? latest.metrics.actualModel ?? latest.metrics.model ?? null,
    reviewId: interrupted.id,
    reviewedPackage: await readPreparedPackage(latest),
  });
  const [persisted] = await persistIndependentReviewArtifactsForRun(latest, [reviewStatus]);
  const nextReviews = latestReviews.map((review) =>
    review.id === interrupted.id ? persisted : review,
  );
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        independentReviews: nextReviews,
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
  assertLaunchAllowed?: (
    reviews: readonly IndependentReviewStatus[],
    slotId: string,
  ) => Promise<void>;
  executeReview?: typeof executeSelfReview;
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
  plan: ReviewLoopRequest[],
  source: 'dispatch' | 'human-gate',
  dependencies: PublishGateReviewPlanDependencies = {},
): Promise<PublishGateReviewPlanResult> {
  const boundedPlan = plan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
  if (boundedPlan.length === 0) {
    clearPublicationReviewLaunchRejection(runId);
    return { reviewIds: [] };
  }
  const assertLaunchAllowed =
    dependencies.assertLaunchAllowed ?? assertIndependentReviewLaunchStateForSlot;
  const executeReview = dependencies.executeReview ?? executeSelfReview;
  const reviewIds: string[] = [];
  for (const planStep of boundedPlan) {
    const launchSnapshot = getRun(runId)!;
    try {
      await assertLaunchAllowed(
        launchSnapshot.engineState?.publishGate?.independentReviews ?? [],
        slotId,
      );
    } catch (error) {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      if (!rejection) throw error;
      const latestAfterGuard = getRun(runId)!;
      updateRun(runId, {
        engineState: {
          ...latestAfterGuard.engineState,
          publishGate: {
            ...latestAfterGuard.engineState?.publishGate,
            reviewLaunchRejection: rejection,
          },
        },
      });
      updateRunStep(runId, S.HUMAN_GATE, {
        detail: `${rejection.message} ${rejection.userAction}`,
        outputs: {
          ...latestAfterGuard.steps.find((step) => step.name === S.HUMAN_GATE)?.outputs,
          reviewLaunchRejection: rejection,
        },
      });
      return { reviewIds, rejection };
    }
    const latestBeforeReview = clearPublicationReviewLaunchRejection(runId);
    const reviewedPackage =
      source === 'human-gate' ? await readPreparedPackage(latestBeforeReview) : undefined;
    // ID + artifact paths flow through EXTRA_REVIEW_SOURCE so this stream stays
    // namespace-isolated from the worker's self-review attempts (review-sources.ts).
    const reviewId = EXTRA_REVIEW_SOURCE.artifactRefs(
      (latestBeforeReview.engineState?.publishGate?.independentReviews ?? []).length + 1,
    ).id;
    const requestedRunner = effectiveReviewRunner(planStep);
    updateRunStep(runId, S.HUMAN_GATE, {
      detail: requestedRunner
        ? `Running ${source} ${requestedRunner} review (${planStep.order}/${boundedPlan.length})...`
        : `Running ${source} independent review (${planStep.order}/${boundedPlan.length})...`,
    });
    const validationDepth =
      planStep.validationDepth ??
      reviewValidationDepthForLoop(planStep.order - 1, boundedPlan.length);
    let reviewResult: SelfReviewResult;
    let reviewRecoveryPending = false;
    try {
      reviewResult = await executeReview(runId, slotId, {
        reviewRunner: requestedRunner,
        model: planStep.model ?? null,
        validationDepth,
        artifactScope: reviewId,
        publicationReview: true,
        reviewSessionIntent: planStep.sessionIntent ?? 'reset',
        // An explicit operator Continue/Fresh choice starts a retained review
        // work order: Fresh resets generation 1, while fixes/re-reviews can
        // still reuse that reviewer. The override is NOT redundant with the
        // warm default — a project configured fresh-per-pass must still honor
        // the operator's explicit retained-session choice.
        ...(planStep.sessionIntent ? { reviewSessionPolicy: 'warm-per-reviewer' as const } : {}),
        // Configured review steps are true review loops: findings are fed back
        // to the original worker, the worker fixes them, then the same reviewer
        // re-reviews before the next configured reviewer starts.
      });
    } catch (err) {
      if (isTerminalReviewArtifactError(err)) throw err;
      reviewRecoveryPending = true;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — ${source} review ${reviewId} unavailable: ${message}`,
      );
      reviewResult = {
        verdict: 'blocked',
        reason: `review-unavailable: ${message}`,
        retryCount: 0,
        validationDepth,
        attempts: [
          {
            loopNumber: 1,
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
    const priorReviews = latest.engineState?.publishGate?.independentReviews ?? [];
    const builtReviewStatus = buildPublishGateReviewStatus({
      source,
      priorReviewCount: priorReviews.length,
      reviewResult,
      requestedRunner,
      workerRunner: latest.metrics.runner,
      model:
        reviewResult.model ??
        planStep.model ??
        runnerDefaultModel(requestedRunner) ??
        latest.metrics.actualModel ??
        latest.metrics.model ??
        null,
      reviewId,
      reviewedPackage,
    });
    const reviewStatus = reviewRecoveryPending
      ? { ...builtReviewStatus, recoveryContinuationPending: true }
      : builtReviewStatus;
    const reviewStatuses = await persistIndependentReviewArtifactsForRun(latest, [reviewStatus]);
    reviewIds.push(...reviewStatuses.map((review) => review.id));
    updateRun(runId, {
      engineState: {
        ...latest.engineState,
        publishGate: {
          ...latest.engineState?.publishGate,
          independentReviews: [...priorReviews, ...reviewStatuses],
        },
      },
    });
    if (reviewResult.verdict !== 'pass') break;
  }
  return { reviewIds };
}
export async function persistIndependentReviewArtifactsForRun(
  run: Run,
  reviews: IndependentReviewStatus[],
): Promise<IndependentReviewStatus[]> {
  if (!run.taskFile || reviews.length === 0) return reviews;
  const taskDir = path.dirname(run.taskFile);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const persisted: IndependentReviewStatus[] = [];
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
    await writeFile(
      path.join(taskDir, refs.mdRel),
      formatIndependentReviewMarkdown(withArtifacts),
      'utf-8',
    );
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
  reviewDepth: ReviewDepthPolicy,
  selectionData: Record<string, unknown> | undefined,
): Promise<void> {
  const before = getRun(runId)!;
  const priorReviews = before.engineState?.publishGate?.independentReviews ?? [];
  const { reviews, restampedIds, oldReviewSubjectHashes } =
    restampStaleApprovingReviewsForEvidenceRefresh(priorReviews, approvedPackage, {
      requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
    });
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
        independentReviews: reviews,
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
    (pv?.projectJson ? getProjectField(pv.projectJson, 'default_branch') : null) || 'main';

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

  const reviewDepth =
    preparedPackage?.reviewDepth ??
    publicationReviewPolicyForRun(
      current,
      pv?.projectJson,
      current.engineState?.publishGate?.reviewDepth,
    );
  const independentReviews = current.engineState?.publishGate?.independentReviews ?? [];
  const pendingReview = pendingIndependentReviewContinuation(independentReviews);
  const pendingReviewContinuation =
    pendingReview && !reviewerIsActiveForReview(current, pendingReview) ? pendingReview : undefined;
  const requiredReviewCount = effectiveRequiredReviewCount(reviewDepth);
  const staleReviewCount =
    publicationApprovalGate && preparedPackage && requiredReviewCount > 0
      ? countStalePublicationReviews(independentReviews, preparedPackage, {
          requireCrossRunnerCertification: reviewDepth.requireCrossRunner,
        })
      : 0;
  const reviewSatisfied =
    !publicationApprovalGate ||
    (independentReviewPolicySatisfied(reviewDepth, independentReviews) && staleReviewCount === 0);
  // The evidence-refresh override is offered ONLY when staleness is purely
  // subject/evidence drift on a still-matching HEAD — never when code changed.
  const evidenceRefreshAction =
    publicationApprovalGate && preparedPackage
      ? buildEvidenceRefreshAction(independentReviews, preparedPackage, reviewDepth)
      : null;
  const unavailableSnapshotAction =
    publicationApprovalGate && preparedPackage
      ? buildUnavailableSnapshotAction(independentReviews, preparedPackage, reviewDepth)
      : null;
  const actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }> =
    publicationApprovalGate
      ? [
          ...(mergedPrNumber || branchZeroAhead
            ? [
                {
                  id: CLOSE_AS_SHIPPED_ACTION,
                  label: mergedPrNumber
                    ? `Close as Shipped (PR #${mergedPrNumber} merged)`
                    : 'Close as Shipped (branch has no commits ahead)',
                  style: 'primary' as const,
                },
              ]
            : []),
          ...(reviewSatisfied
            ? [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }]
            : []),
          ...(evidenceRefreshAction ? [evidenceRefreshAction] : []),
          ...(unavailableSnapshotAction ? [unavailableSnapshotAction] : []),
          ...(pendingReviewContinuation
            ? [
                {
                  id: CONTINUE_REVIEW_FIX_ACTION,
                  label: `Continue Fixing ${pendingReviewContinuation.unresolvedCount} Finding${pendingReviewContinuation.unresolvedCount === 1 ? '' : 's'}`,
                  style: 'primary' as const,
                },
              ]
            : []),
          { id: 'hold', label: 'Hold', style: 'secondary' as const },
          {
            id: 'request-extra-review',
            label: 'Request Independent Review',
            style: 'secondary' as const,
          },
          {
            id: 'request-cross-runner-review',
            label: 'Request Independent Review (runner diversity)',
            style: 'secondary' as const,
          },
        ]
      : [
          { id: 'ready', label: 'Mark Ready', style: 'primary' },
          { id: 'hold', label: 'Hold', style: 'secondary' },
        ];

  const recipeJson = await readTaskArtifactText(current.taskFile, 'recipe.json');
  const recipeCoverage = await readTaskArtifactText(current.taskFile, 'recipe-coverage.md');

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

  // Read self-review step output
  let selfReviewVerdict: string | undefined;
  let selfReviewSummary: string | undefined;
  const selfReviewStep = current.steps.find((s) => s.name === 'self-review');
  if (selfReviewStep?.outputs) {
    const out = selfReviewStep.outputs as Record<string, unknown>;
    selfReviewVerdict =
      typeof out.verdict === 'string' ? out.verdict : out.skipped ? 'skipped' : undefined;
    const issues = Array.isArray(out.issues)
      ? out.issues.filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    if (issues.length > 0) {
      selfReviewSummary = issues
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
      selfReviewVerdict,
      selfReviewSummary,
      workerLearnings,
      reviewLaunchRejection,
      ciChecks,
      acceptanceCriteria,
      inputSnapshot,
      ...(preparedPackage
        ? {
            prPackage: preparedPackage,
            reviewDepth,
            independentReviews,
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
  // for codex). Sort by resolvedAt so a second request-extra-review wins.
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
        getRun(runId)!.engineState?.publishGate?.independentReviews ?? [],
        approvedPackage,
        reviewDepth,
      );
      await applyEvidenceRefreshOverride(
        runId,
        approvedPackage,
        decision,
        reviewDepth,
        selectionData,
      );
    }
    if (actionId === APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION) {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      assertUnavailableSnapshotOverrideAvailable(
        getRun(runId)!.engineState?.publishGate?.independentReviews ?? [],
        approvedPackage,
        reviewDepth,
      );
    }
    if (isPublishApprovalAction(actionId)) {
      if (!approvedPackage) throw new Error('Publication approval requires a prepared package');
      validatePackageApprovalSelection(approvedPackage, decision);
      assertPublicationReviewPolicySatisfied(getRun(runId)!, approvedPackage);
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
    const requestRequiresCrossRunner = reviewRequest.requireCrossRunner === true;
    const requestedPlan: ReviewLoopRequest[] =
      actionId === 'request-cross-runner-review' &&
      !selectedPlan.some((loop) => effectiveReviewRunner(loop))
        ? [
            {
              order: 1,
              runner: defaultAlternateReviewRunner(
                current.metrics.runner,
              ) as ReviewLoopRequest['runner'],
              validationDepth: 'static-code' as const,
            },
          ]
        : selectedPlan;
    const loopsToAdd =
      actionId === 'request-cross-runner-review'
        ? Math.max(1, requestedPlan.length)
        : requestedReviewLoopCount(reviewRequest, requestedPlan.length);
    const reviewRequestConsumed = markResolvedHumanGateReviewRequestConsumed(decision);
    const baseReviewDepth = publicationReviewPolicyForRun(current, pv?.projectJson);
    const patch =
      actionId === 'request-extra-review' || actionId === 'request-cross-runner-review'
        ? {
            reviewDepth: humanGateReviewDepth(
              baseReviewDepth,
              { ...reviewRequest, requireCrossRunner: requestRequiresCrossRunner },
              { actionId, fallbackLoopCount: loopsToAdd },
            ),
            pendingReviewPlan: requestedPlan,
            pendingReviewPlanRequestedAt: new Date().toISOString(),
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
