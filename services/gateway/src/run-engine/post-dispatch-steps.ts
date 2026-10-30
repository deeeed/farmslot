import { setTimeout as delay } from 'node:timers/promises';

import {
  type ArtifactRef,
  type DiffStat,
  Events,
  FLOW_STEPS,
  type InheritedAcceptanceProvenance,
  isInteractiveDevRun,
  isLightweightInteractiveDevRun,
  isPublishEvidenceArtifact,
  isReviewValidationDepth,
  PipelineSteps,
  type ReadyGatePrPackage,
  reviewPolicySatisfied,
  type ReviewSelection,
  type ReviewValidationDepth,
  type Run,
  type RunSubtaskMetrics,
  SEND_BACK_TO_AGENT_ACTION,
  type SlotReleaseParams,
  type WorkerSignal,
} from '@farmslot/protocol';
import {
  executionModelFromSelection,
  parseReviewSelection,
  publicationReviewBlockingReason,
  resolveReviewDispatchDefaults,
  resolveReviewMode,
  reviewContextFromRequest,
} from '@farmslot/review-dispatch';

import { markSlotBusy, markSlotHeld, updateSlotStatusIf } from '../core/index.js';
import { freezeBlindTrialFirstOutput } from '../evals/blind-trial.js';
import {
  finalizeEvalResultPackageForRun,
  freezeEvalFirstOutputPackage,
  readFrozenEvalFirstOutputPackage,
} from '../evals/package-store.js';
import { loadFleetStatus } from '../fleet/state.js';
import { assertQaCompletion } from '../qa/completion.js';
import { PIPELINE_REVIEW_SOURCE } from '../quality/review-sources.js';
import { readPRCompletionHead } from '../review/acceptance-coverage.js';
import {
  executeReview,
  reReviewMode,
  type ReviewOptions,
  type ReviewResult,
} from '../review/orchestrator.js';
import {
  markReviewedInputsRerun,
  reviewedInputsAwaitingReview,
} from '../review/reviewed-inputs.js';
import {
  latestReviewOfLineage,
  lineageContextForRun,
  reReviewOfStatus,
} from '../review/session-mode.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import {
  extractAndPersistSessionCost,
  isArtifactOnlyRun,
  prepareCompletionPackage,
  runCompletionPipeline,
} from '../run-completion/orchestrator.js';
import { captureRunOutput, failRunOutputCapture } from '../run-completion/output.js';
import {
  computeReadyGateReviewSubjectHash,
  readReadyGatePreparedPackage,
} from '../run-completion/ready-gate-package.js';
import {
  ResultDecisionHoldError,
  runDeliveredResult,
  takeSendBackReview,
} from '../run-completion/result-decision.js';
import { readRunProgress } from '../runners/run-progress.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { collectRunSubtaskMetrics, withSubtaskMetrics } from '../tasks/subtask-metrics.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { abandonBranchMaintenance, completeBranchMaintenance } from './branch-maintenance.js';
import {
  isHumanGateReviewRequestAction,
  markResolvedHumanGateReviewRequestConsumed,
} from './decision-replay.js';
import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import {
  CLOSE_AS_SHIPPED_ACTION,
  CONTINUE_REVIEW_FIX_ACTION,
  gateReviewContinuationForRun,
  isPublishApprovalAction,
  reviewFinalSnapshotMatchesPreparedPackage,
  shouldForceNoChangeHumanGate,
  stampPublishGateReviewStatusForPackage,
  supersedeStaleHumanGateDecisions,
} from './gate-policy.js';
import { assertRunGateReady, RunGateNotReadyError } from './gate-prerequisites.js';
import { loadProjectVarsOrNull } from './project-vars.js';
import { shouldResumePublicationGate } from './publication-finalization.js';
import {
  publicationReviewPolicyForRun,
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from './publication-policy.js';
import { verifyWorkerPushedBranch } from './push-verification.js';
import {
  type PublishGateReviewPlanDependencies,
  type PublishGateReviewPlanResult,
  resumeInterruptedPublicationReview,
  resumeVisualRepair,
} from './ready-gate.js';
import {
  normalizeExhaustedReviewContinuationsForRun,
  recoverInflightPublicationReviews,
  TerminalReviewArtifactError,
} from './recover-inflight-reviews.js';
import { reconcileRunPosture } from './resource-posture.js';
import {
  automaticPublicationReviewPlan,
  humanGateReviewPolicy,
  humanGateReviewRequestFromDecision,
  pipelineReviewSatisfiesFirstRow,
  remainingExplicitReviewPlan,
  repairUnboundRecoveryReviewPlan,
  resolveHumanGateReviewExecutionPlan,
} from './review-plan.js';
import { recordArtifactOnlyReviewResult } from './review-result.js';
import { runSupersededSince } from './run-generation.js';
import { type MonitorResult, monitorRun, probeWorkerSignalForRun } from './run-monitor.js';
import { activeVisualRepair } from './visual-repair.js';

const S = PipelineSteps;

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export function holdInteractiveCompletionForOperator(
  current: Run,
  stepOutputs: Record<string, unknown>,
  workerStatus: 'complete' | 'done' | 'blocked' | 'failed',
): Record<string, unknown> {
  const monitorStep = current.steps.find((step) => step.name === S.MONITOR);
  const needsContinuation = workerStatus === 'blocked' || workerStatus === 'failed';
  const heldOutputs = {
    ...stepOutputs,
    workerTerminalSignalHeld: workerStatus,
    awaitingOperator: true,
    reason: needsContinuation
      ? 'interactive-worker-operator-owned'
      : 'interactive-completion-operator-owned',
  };
  updateRunStep(current.id, S.MONITOR, {
    detail: needsContinuation
      ? `Worker reported ${workerStatus}; provide direction and Resume, or choose a completion action`
      : 'Worker finished; waiting for operator action',
    durationMs: monitorStep?.startedAt
      ? Date.now() - new Date(monitorStep.startedAt).getTime()
      : undefined,
    outputs: heldOutputs,
  });
  updateRun(current.id, { status: 'paused' });
  return heldOutputs;
}

type BroadcastFn = (event: string, payload: unknown) => void;
type MonitorTerminalErrorArgs = {
  status: 'blocked' | 'failed';
  outcome: 'partial' | 'failure';
  reason: string;
  stepInputs: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
};

export interface PostDispatchStepContext {
  prCompletionHead?: typeof readPRCompletionHead;
  assertGatePrerequisites?: typeof assertRunGateReady;
  waitForCompletionProgress?: () => Promise<void>;
  activeMonitors: Map<string, AbortController>;
  blockedRunError: (message: string, reason: string) => Error;
  broadcastFn: BroadcastFn;
  createEngineDecision: typeof import('./engine-decisions.js').createEngineDecision;
  executeNoChangeGate: (runId: string) => Promise<void>;
  executePublishGateReviewPlan: (
    runId: string,
    slotId: string,
    plan: ReviewSelection[],
    trigger: 'dispatch' | 'human-gate',
    options?: Pick<PublishGateReviewPlanDependencies, 'automaticLaunch' | 'reviewSequenceContext'>,
  ) => Promise<PublishGateReviewPlanResult>;
  executeReadyGate: (runId: string) => Promise<string>;
  executeReviewGate: (runId: string) => Promise<void>;
  getDiffStat: (run: Run) => Promise<DiffStat>;
  interactiveLightweightSkipOutputs: (step: string) => StepIO;
  isHumanGateEnabled: (
    project: string,
    flowType: Run['flowType'],
    mode: Run['mode'],
  ) => Promise<boolean>;
  monitorTerminalError: (args: MonitorTerminalErrorArgs) => Error;
  prepareCompletionPackageForRun?: typeof prepareCompletionPackage;
  executeReviewForRun?: typeof executeReview;
  readEvalWorkerProgress?: typeof readRunProgress;
  extractEvalWorkerCost?: typeof extractAndPersistSessionCost;
  waitForEvalWorkerProgress?: () => Promise<void>;
  resumeInterruptedPublicationReviewForRun?: typeof resumeInterruptedPublicationReview;
  resumeVisualRepairForRun?: typeof resumeVisualRepair;
  probeWorkerSignalForRun?: typeof probeWorkerSignalForRun;
  refreshRunLinks: (runId: string) => Promise<void>;
  stepPartialIO: Map<string, StepIO>;
  /**
   * Hand a TERMINAL slot release to the engine instead of performing it here.
   *
   * Only used when COMPLETE is the flow's last step: the engine runs it as a
   * transition after-effect, so the run reaches `done` before tmux teardown
   * starts rather than after it (ADR-053).
   */
  deferTerminalSlotRelease: (params: SlotReleaseParams) => void;
}

export function persistedUpdateBranchNeedsReview(
  run: Pick<Run, 'flowType' | 'steps'>,
): boolean | undefined {
  if (run.flowType !== 'update-branch') return undefined;
  const monitorStep = run.steps.find((step) => step.name === S.MONITOR);
  if (monitorStep?.status !== 'done') return undefined;
  const workerSignal = monitorStep.outputs?.workerSignal as WorkerSignal | undefined;
  if (workerSignal === null || typeof workerSignal !== 'object') return undefined;
  if (workerSignal.status !== 'complete' && workerSignal.status !== 'done') return undefined;
  return typeof workerSignal.needsReview === 'boolean' ? workerSignal.needsReview : undefined;
}

export function shouldSkipRetrospectiveAtComplete(run: Pick<Run, 'flowType'>): boolean {
  // CI-watch is the terminal PR lifecycle step for publishable flows. Defer the
  // retrospective there so the card captures the whole family outcome instead
  // of the pre-CI completion snapshot. Human-gate alone is not terminal; review
  // flows without CI still need a retrospective after their complete step.
  return FLOW_STEPS[run.flowType].includes(S.CI_WATCH);
}
const MAX_PUBLISH_GATE_REVIEW_LOOPS = 5;

function stampFreshReviewsForPreparedPackage(
  runId: string,
  reviewIds: string[],
  prPackage: Pick<
    ReadyGatePrPackage,
    'headSha' | 'reviewSnapshot' | 'packageInputHash' | 'reviewSubjectHash'
  >,
): void {
  if (reviewIds.length === 0) return;
  const reviewIdSet = new Set(reviewIds);
  const latest = getRun(runId)!;
  const reviews = latest.engineState?.publishGate?.reviews ?? [];
  const stampedReviews = reviews.map((review) =>
    reviewIdSet.has(review.id) && reviewFinalSnapshotMatchesPreparedPackage(review, prPackage)
      ? stampPublishGateReviewStatusForPackage(review, prPackage)
      : review,
  );
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: stampedReviews,
      },
    },
  });
}

export async function reconcilePublishGateReviewPlanResult(
  runId: string,
  plan: ReviewSelection[],
  result: PublishGateReviewPlanResult,
  context: Pick<PostDispatchStepContext, 'getDiffStat' | 'prepareCompletionPackageForRun'>,
  options: {
    reviewedPackage?: ReadyGatePrPackage;
    stampFreshReviews?: boolean;
  } = {},
): Promise<number> {
  const afterReviewPlan = getRun(runId)!;
  const reviewedIds = new Set(result.reviewIds);
  const remainingPlan = remainingExplicitReviewPlan(
    plan,
    (afterReviewPlan.engineState?.publishGate?.reviews ?? []).filter((review) =>
      reviewedIds.has(review.id),
    ),
  );
  const completedReviewCount = plan.length - remainingPlan.length;
  updateRun(runId, {
    engineState: {
      ...afterReviewPlan.engineState,
      publishGate: {
        ...afterReviewPlan.engineState?.publishGate,
        reviewSequence: remainingPlan,
        reviewSequenceContext:
          remainingPlan.length && afterReviewPlan.engineState?.publishGate?.reviewSequenceContext
            ? {
                reviewLineages:
                  afterReviewPlan.engineState.publishGate.reviewSequenceContext.reviewLineages.slice(
                    completedReviewCount,
                  ),
              }
            : undefined,
        reviewSequenceRequestedAt: remainingPlan.length ? new Date().toISOString() : undefined,
      },
    },
  });
  getRun(runId)!;
  const diffStat = await context.getDiffStat(getRun(runId)!);
  const prepared = await prepareGatePackageAfterReviews(runId, () =>
    (context.prepareCompletionPackageForRun ?? prepareCompletionPackage)(runId, {
      diffStat,
      reviewPolicy: getRun(runId)?.engineState?.publishGate?.reviewPolicy,
      publicationTarget: getRun(runId)?.engineState?.publishGate?.publicationTarget,
      ...(options.stampFreshReviews
        ? {
            selectedEvidenceKeys: options.reviewedPackage?.selectedEvidenceKeys,
            priorEvidenceManifest: options.reviewedPackage?.evidenceManifest,
            stampReviews: false,
          }
        : {}),
      requireArtifactMirror: true,
    }),
  );
  if (prepared && options.stampFreshReviews) {
    stampFreshReviewsForPreparedPackage(runId, result.reviewIds, prepared.prPackage);
  }
  return completedReviewCount;
}

/**
 * Prepare the gate's package once its reviews settled. A package the gate cannot
 * prepare yet (a stale CI receipt, say) is left to executeReadyGate, whose durable
 * wait keeps the slot, offers Retry Gate and Continue Fixing, and re-stamps the
 * settled reviews on its refresh. Throwing here failed the run and released the
 * checkout (TAT-4145 bda11b1a).
 */
async function prepareGatePackageAfterReviews(
  runId: string,
  prepare: () => ReturnType<typeof prepareCompletionPackage>,
): Promise<Awaited<ReturnType<typeof prepareCompletionPackage>> | undefined> {
  try {
    return await prepare();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)} — gate package not prepared after review; the gate retries it: ${message.slice(0, 200)}`,
    );
    return undefined;
  }
}

async function freezeEvalWorkerFacts(run: Run, context: PostDispatchStepContext): Promise<void> {
  if (await readFrozenEvalFirstOutputPackage(run)) return;
  const generation = run.engineState?.generation ?? 0;
  for (;;) {
    const current = getRun(run.id);
    if (runSupersededSince(current, generation))
      throw new Error('Eval worker capture was superseded');
    const progress = await (context.readEvalWorkerProgress ?? readRunProgress)(current!);
    if (progress.kind === 'idle') break;
    if (progress.kind !== 'making-progress') throw new Error('Eval worker idle is unconfirmed');
    updateRunStep(run.id, S.REVIEW, { detail: 'Waiting for the first worker turn to finish' });
    await (context.waitForEvalWorkerProgress?.() ?? delay(250));
  }
  const cost = await (context.extractEvalWorkerCost ?? extractAndPersistSessionCost)(run.id);
  const current = getRun(run.id);
  if (runSupersededSince(current, generation))
    throw new Error('Eval worker capture was superseded');
  const first = current?.engineState?.evalExperiment?.blind?.firstOutput;
  const started = Date.parse(
    current?.steps.find(({ name }) => name === S.DISPATCH)?.startedAt ?? '',
  );
  const ended = Date.parse(first?.capturedAt ?? '');
  await freezeEvalFirstOutputPackage(current!, {
    durationMs:
      Number.isFinite(started) && Number.isFinite(ended) && ended >= started
        ? ended - started
        : undefined,
    costEstimate: cost.costUsd ?? undefined,
    sessionTurns: cost.turns ?? undefined,
    sessionInputTokens: cost.inputTokens ?? undefined,
    sessionOutputTokens: cost.outputTokens ?? undefined,
    sessionTotalTokens: cost.totalTokens ?? undefined,
  });
}

export function readyGateReviewSubjectMatches(
  reviewedPackage: ReadyGatePrPackage | null | undefined,
  preparedPackage: ReadyGatePrPackage | null | undefined,
): boolean {
  if (!reviewedPackage || !preparedPackage) return false;
  if (!reviewedPackage.headSha || !preparedPackage.headSha) return false;
  const reviewedSubjectHash = computeReadyGateReviewSubjectHash(reviewedPackage);
  const preparedSubjectHash = computeReadyGateReviewSubjectHash(preparedPackage);
  if (reviewedPackage.headSha !== preparedPackage.headSha) return false;
  if (reviewedSubjectHash === preparedSubjectHash) return true;
  return legacyReviewSubjectMatchesIgnoringNewEvidenceDigests(reviewedPackage, preparedPackage);
}

function legacyReviewSubjectMatchesIgnoringNewEvidenceDigests(
  reviewedPackage: ReadyGatePrPackage,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  if (reviewedPackage.branch !== preparedPackage.branch) return false;
  if ((reviewedPackage.remoteBranchRef ?? null) !== (preparedPackage.remoteBranchRef ?? null))
    return false;
  const reviewedDiffHash = reviewedPackage.reviewSnapshot?.diffHash;
  const preparedDiffHash = preparedPackage.reviewSnapshot?.diffHash;
  if (reviewedDiffHash && preparedDiffHash && reviewedDiffHash !== preparedDiffHash) return false;
  if (JSON.stringify(reviewedPackage.diffStat) !== JSON.stringify(preparedPackage.diffStat))
    return false;
  if (
    (reviewedPackage.validationSummaryHash ?? null) !==
    (preparedPackage.validationSummaryHash ?? null)
  )
    return false;
  if (!legacySelectedEvidenceKeysMatch(reviewedPackage, preparedPackage)) return false;
  return evidenceRefsMatchAllowingAddedDigests(
    reviewSubjectEvidenceRefs(reviewedPackage),
    reviewSubjectEvidenceRefs(preparedPackage),
  );
}

function legacySelectedEvidenceKeysMatch(
  reviewedPackage: ReadyGatePrPackage,
  preparedPackage: ReadyGatePrPackage,
): boolean {
  const reviewed = canonicalSelectedEvidenceKeysForPackage(reviewedPackage);
  const prepared = canonicalSelectedEvidenceKeysForPackage(preparedPackage);
  return (
    reviewed.length === prepared.length && reviewed.every((key, index) => key === prepared[index])
  );
}

function canonicalSelectedEvidenceKeysForPackage(prPackage: ReadyGatePrPackage): string[] {
  const manifest = prPackage.evidenceManifest ?? [];
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
    ...new Set(
      (prPackage.selectedEvidenceKeys ?? [])
        .filter((key): key is string => typeof key === 'string')
        .map(resolve),
    ),
  ].sort();
}

function reviewSubjectEvidenceRefs(prPackage: ReadyGatePrPackage): ArtifactRef[] {
  const selected = new Set(
    (prPackage.selectedEvidenceKeys ?? []).flatMap((key) => evidenceKeyVariants(key)),
  );
  return (prPackage.evidenceManifest ?? [])
    .filter((artifact) =>
      selected.size > 0
        ? evidenceKeyVariants(artifact.path).some((variant) => selected.has(variant))
        : isPublishEvidenceArtifact(artifact),
    )
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        String(a.purpose ?? '').localeCompare(String(b.purpose ?? '')) ||
        (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1),
    );
}

function evidenceRefsMatchAllowingAddedDigests(
  reviewedRefs: ArtifactRef[],
  preparedRefs: ArtifactRef[],
): boolean {
  if (reviewedRefs.length !== preparedRefs.length) return false;
  for (let index = 0; index < reviewedRefs.length; index += 1) {
    const reviewed = reviewedRefs[index];
    const prepared = preparedRefs[index];
    if (reviewed.path !== prepared.path) return false;
    if ((reviewed.purpose ?? null) !== (prepared.purpose ?? null)) return false;
    if ((reviewed.sizeBytes ?? null) !== (prepared.sizeBytes ?? null)) return false;
    if (reviewed.sha256 && prepared.sha256 && reviewed.sha256 !== prepared.sha256) return false;
  }
  return true;
}

/**
 * Base review is static (ADR-058). A run whose base review already launched under the
 * live contract keeps it across restarts; the chosen depth is recorded on the step.
 */
export function baseReviewPolicy(run: Run): ReviewValidationDepth {
  const recorded = run.steps.find((step) => step.name === S.REVIEW)?.inputs?.validationDepth;
  if (isReviewValidationDepth(recorded)) return recorded;
  const launchedBeforeRecording = run.agentContexts?.some(
    (context) => context.role === 'review' && !context.artifactScope,
  );
  return launchedBeforeRecording ? 'full-live' : 'static-code';
}

export async function executeMonitorStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { activeMonitors, broadcastFn, monitorTerminalError } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const inputs: Record<string, unknown> = { slotId: current.slotId };
  const controller = new AbortController();
  activeMonitors.set(runId, controller);
  const generation = current.engineState?.generation ?? 0;
  const canSettle = () => {
    const latest = getRun(runId);
    return Boolean(
      latest &&
      !controller.signal.aborted &&
      activeMonitors.get(runId) === controller &&
      (latest.engineState?.generation ?? 0) === generation &&
      latest.slotId === current.slotId &&
      !['done', 'failed', 'cancelled', 'paused'].includes(latest.status),
    );
  };
  const retiredResult = (): StepIO => ({ inputs, outputs: { exitReason: 'aborted' } });
  let monitorResult: MonitorResult | undefined;
  try {
    monitorResult = await monitorRun(runId, current.slotId, controller.signal);
  } catch (err) {
    if (activeMonitors.get(runId) === controller) activeMonitors.delete(runId);
    throw err;
  }
  // The controller stays registered through push verification below so run
  // cancellation can still interrupt the bounded post-completion wait; the
  // try/finally covers every remaining exit path of this step.
  try {
    if (!canSettle()) return retiredResult();
    // Worker is done — clear agent status
    await updateSlotStatusIf(
      current.slotId,
      (slot) => slot.current_run_id === runId && canSettle(),
      { agent: 'idle' },
    );
    if (!canSettle()) return retiredResult();
    const after = getRun(runId)!;
    const workerSignal = monitorResult?.workerSignal ?? null;
    // Child checklist units (ADR-060) roll up beside the parent's timing: read
    // once here, from the registry and child signals on the slot, because the
    // task directory can be pruned before any later reader wants them.
    let subtaskMetrics: RunSubtaskMetrics[] | null = null;
    try {
      subtaskMetrics = await collectRunSubtaskMetrics(after, current.slotId);
    } catch (err) {
      // A corrupt registry or an unloadable project config must not lose the
      // parent's own metrics, which are the run's primary cost record — so this
      // recovery stays. Error level, not warn: child durations are missing from
      // the retrospective for this run and nothing downstream will say why. The
      // same read throws to its caller in task.progress, where the operator sees
      // it on the next progress request.
      console.error(
        `[run-engine] run ${runId.slice(0, 8)} — subtask metrics unavailable for ${after.taskFile ?? 'unknown task dir'}: ${(err as Error).message}`,
      );
    }
    if (
      workerSignal?.disposition ||
      workerSignal?.evidence ||
      workerSignal?.checklistTiming ||
      subtaskMetrics
    ) {
      updateRun(runId, {
        metrics: withSubtaskMetrics(
          {
            ...after.metrics,
            ...(workerSignal?.disposition ? { disposition: workerSignal.disposition } : {}),
            ...(workerSignal?.evidence ? { terminalEvidence: workerSignal.evidence } : {}),
            // Persist per-step timing so it survives task-dir pruning and feeds the gate summary.
            ...(workerSignal?.checklistTiming
              ? { checklistTiming: workerSignal.checklistTiming }
              : {}),
          },
          subtaskMetrics,
        ),
      });
    }
    const cliCommand = `farmslot slot check ${current.slotId}`;
    const stepOutputs = {
      nudgeCount: after.metrics.nudgeCount,
      pollCount: monitorResult?.pollCount ?? 0,
      exitReason: monitorResult?.exitReason ?? 'error',
      violations: monitorResult?.violations ?? [],
      snapshots: monitorResult?.snapshots ?? [],
      workerSignal,
      cliCommand,
    };
    if (workerSignal && ['complete', 'done', 'blocked', 'failed'].includes(workerSignal.status)) {
      try {
        await captureRunOutput(runId, true, true);
      } catch (error) {
        if (!canSettle()) return retiredResult();
        // Preserve the worker's outcome; a failed transfer is separately visible
        // and retryable through run.refreshMirror, never an empty success card.
        failRunOutputCapture(runId, error, true);
      }
      if (!canSettle()) return retiredResult();
      await freezeBlindTrialFirstOutput(runId);
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    }
    if (
      !after.engineState?.evalExperiment &&
      ((isInteractiveDevRun(after) &&
        (workerSignal?.status === 'blocked' || workerSignal?.status === 'failed')) ||
        (isLightweightInteractiveDevRun(after) &&
          (workerSignal?.status === 'complete' || workerSignal?.status === 'done')))
    ) {
      // Interactive findings belong to the operator. Pause before failure cleanup
      // or COMPLETE can release the slot; retain the original signal as evidence.
      // Reviewed success still advances through the configured review pipeline.
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — worker '${workerSignal.status}' signal held; ` +
          'interactive completion is operator-owned',
      );
      const heldOutputs = holdInteractiveCompletionForOperator(
        after,
        stepOutputs,
        workerSignal.status,
      );
      // Broadcast it: the orchestrator's post-step guard returns before its own
      // RUN_UPDATED, so without this Command Center keeps showing `monitoring`
      // until the next refetch — and offers a Pause button that then errors
      // because the backend is already paused.
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      // ADR-054: the run is now waiting on its operator, so shed what that wait
      // does not need. Never throws; a failure is recorded on the run's posture.
      await reconcileRunPosture({ runId, boundary: 'operator-wait' });
      return {
        inputs,
        outputs: heldOutputs,
      };
    }
    if (workerSignal?.status === 'blocked' || workerSignal?.status === 'failed') {
      // Non-interactive failures use the engine's status and cleanup path.
      throw monitorTerminalError({
        status: workerSignal.status,
        outcome: workerSignal.status === 'blocked' ? 'partial' : 'failure',
        reason: workerSignal.reason ?? after.error ?? `worker signaled ${workerSignal.status}`,
        stepInputs: inputs,
        stepOutputs,
      });
    }
    if (workerSignal?.status === 'complete' || workerSignal?.status === 'done') {
      if (after.flowType === 'qa') {
        const qaEvidence = await assertQaCompletion(after);
        if (!canSettle()) return retiredResult();
        (stepOutputs as Record<string, unknown>).qaEvidence = qaEvidence;
      }
      // Worker-owned-push flows must have the branch published before the run
      // advances — otherwise ci-watch evaluates a stale remote SHA and loops.
      // `done` is an accepted terminal alias for `complete` (isTerminalWorkerSignal),
      // so it must take the same verification path.
      const pushVerification = await verifyWorkerPushedBranch(
        runId,
        current.slotId,
        controller.signal,
      );
      (stepOutputs as Record<string, unknown>).pushVerification = pushVerification;
      // An aborted verification means the run was cancelled mid-wait — the
      // cancel path owns the run status; do not overwrite it with blocked.
      if (!pushVerification.verified && !pushVerification.aborted) {
        throw monitorTerminalError({
          status: 'blocked',
          outcome: 'partial',
          reason: pushVerification.reason ?? 'worker signaled complete with unpublished work',
          stepInputs: inputs,
          stepOutputs,
        });
      }
    }
    return { inputs, outputs: stepOutputs };
  } finally {
    // Guarded delete: a pause→resume can register a NEW controller for this
    // run while the old verifier is still in its bounded wait — the stale
    // step must not clobber the live monitor's registration.
    if (activeMonitors.get(runId) === controller) activeMonitors.delete(runId);
  }
}

export async function executeReviewStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { createEngineDecision, interactiveLightweightSkipOutputs, stepPartialIO } = context;
  const current = getRun(runId)!;
  const evalJudge = Boolean(current.engineState?.evalExperiment);
  if (!current.slotId) throw new Error('No slot assigned');
  const slotId = current.slotId;
  // ADR-063 Amendment 3: the dispatch's first review row also selects the pipeline
  // reviewer, while the stored sequence is still the dispatch's own plan (a gate,
  // request or recovery that rewrites it stamps requestedAt). Recorded on the step,
  // so its rechecks use it after the gate consumes the row.
  const publishGate = current.engineState?.publishGate;
  const reviewSelection =
    !publishGate?.reviewSequenceRequestedAt &&
    publishGate?.reviewPolicy?.requestedBy !== 'human-gate'
      ? publishGate?.reviewSequence?.[0]
      : undefined;
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    enabled: true,
    ...(reviewSelection ? { reviewSelection } : {}),
  };
  if (current.flowType === 'pr-complete')
    return {
      inputs: { ...inputs, enabled: false },
      outputs: { skipped: true, reason: 'pr-complete-has-no-reviewer' },
    };

  if (evalJudge) await freezeEvalWorkerFacts(current, context);

  if (!evalJudge && isLightweightInteractiveDevRun(current)) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — review skipped for interactive lightweight dev policy`,
    );
    const skipped = interactiveLightweightSkipOutputs(S.REVIEW);
    return { inputs: { ...inputs, ...skipped.inputs }, outputs: skipped.outputs };
  }

  if (!evalJudge && isNoCodeTerminalDisposition(current.metrics.disposition)) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — review skipped for no-code disposition ${current.metrics.disposition}`,
    );
    return {
      inputs: { ...inputs, enabled: false, disposition: current.metrics.disposition },
      outputs: {
        skipped: true,
        reason: 'no-code-terminal-disposition',
        disposition: current.metrics.disposition,
      },
    };
  }

  // update-branch: check worker's signal to decide if review is needed
  if (current.flowType === 'update-branch') {
    const persistedNeedsReview = persistedUpdateBranchNeedsReview(current);
    if (persistedNeedsReview === false) {
      console.log(
        `[run-engine] run ${runId.slice(0, 8)} — update-branch worker says review not needed (persisted monitor signal)`,
      );
      return {
        inputs: { ...inputs, enabled: false },
        outputs: {
          skipped: true,
          reason: 'worker-signal-trivial',
          workerSignalSource: 'persisted-monitor',
        },
      };
    }
    if (persistedNeedsReview === undefined) {
      try {
        const probe = await (context.probeWorkerSignalForRun ?? probeWorkerSignalForRun)(
          runId,
          current.slotId,
        );
        if (probe.ok && probe.signal?.needsReview === false) {
          console.log(
            `[run-engine] run ${runId.slice(0, 8)} — update-branch worker says review not needed (slot signal probe)`,
          );
          return {
            inputs: { ...inputs, enabled: false },
            outputs: {
              skipped: true,
              reason: 'worker-signal-trivial',
              workerSignalSource: 'slot-probe',
            },
          };
        }
      } catch (err) {
        // Signal not found or unreadable — default to running review
        console.warn(
          `[run-engine] update-branch worker signal unavailable for ${runId.slice(0, 8)}; running review: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }
  }

  const validationDepth = baseReviewPolicy(current);
  inputs.validationDepth = validationDepth;
  const reviewStep = current.steps.find((step) => step.name === S.REVIEW);
  updateRunStep(runId, S.REVIEW, {
    inputs: { ...reviewStep?.inputs, validationDepth },
  });
  const executeReviewForRun = context.executeReviewForRun ?? executeReview;
  const execution = reviewSelection ? executionModelFromSelection(reviewSelection) : null;
  // Without a sequence the project's review configuration selects the reviewer.
  const reviewer = execution
    ? { reviewRunner: execution.runner, model: execution.model, effort: execution.effort }
    : {};
  const mode = current.reviewMode;
  const primaryContext = current.reviewContext ?? current.prWork?.review?.options.reviewContext;
  const reviewId =
    mode === 'warm'
      ? primaryContext?.reviewLineages[0]?.reviewId
      : mode === 'cold'
        ? PIPELINE_REVIEW_SOURCE.artifactRefs(1, runId).id
        : undefined;
  // A result decision's Send back continues from its recorded findings: the
  // worker gets them first, as Continue Fixing does, instead of a fresh review.
  const sendBack = takeSendBackReview(runId);
  let result: ReviewResult = await executeReviewForRun(
    runId,
    current.slotId,
    sendBack
      ? {
          ...reviewer,
          validationDepth: sendBack.validationDepth ?? validationDepth,
          mode: reReviewMode(sendBack, mode),
          reviewId: sendBack.reviewId ?? reviewId,
          resumeFromResult: sendBack,
        }
      : { ...reviewer, validationDepth, mode, reviewId, ...(evalJudge ? { maxRetries: 0 } : {}) },
  );
  const cliCommand = `farmslot rpc review.run '{"runId":"${runId}"}'`;
  if (evalJudge) {
    if (
      result.skipped ||
      (result.verdict !== 'pass' && result.verdict !== 'issues') ||
      result.retryCount !== 0
    )
      throw new Error(
        `Eval judge did not complete: ${result.reason ?? result.verdict ?? 'unknown'}`,
      );
    return { inputs, outputs: { ...result, cliCommand } };
  }
  let interactiveRetry = false;

  // Every independent reviewer can produce findings that need an operator choice.
  const interactiveFeedback = async (
    reviewed: ReviewResult,
    selected: Pick<ReviewOptions, 'reviewRunner' | 'model' | 'effort'> = reviewer,
  ): Promise<ReviewResult> => {
    if (current.mode !== 'interactive' || reviewed.skipped || reviewed.verdict !== 'issues')
      return reviewed;
    const issueCount = reviewed.issues?.length ?? 0;
    const issueList =
      reviewed.issues
        ?.map(
          (issue) =>
            `- **${issue.file}${issue.line ? ':' + issue.line : ''}**: ${issue.description}`,
        )
        .join('\n') ?? '';
    const desc = `Review found ${issueCount} issue${issueCount !== 1 ? 's' : ''}.\n\n${issueList}`;
    const actionId = await createEngineDecision(runId, 'review_complete', desc, [
      { id: 'send_feedback', label: 'Send feedback to worker', style: 'primary' },
      { id: 'skip', label: 'Skip — proceed to human gate', style: 'secondary' },
    ]);
    if (actionId !== 'send_feedback') return reviewed;
    interactiveRetry = true;
    return executeReviewForRun(runId, slotId, {
      ...selected,
      validationDepth,
      mode: reReviewMode(reviewed, 'cold'),
      reviewId: reviewed.reviewId,
      resumeFromResult: reviewed,
    });
  };
  result = await interactiveFeedback(result);
  if (interactiveRetry)
    return {
      inputs: { ...inputs, enabled: true },
      outputs: { ...result, cliCommand, interactiveRetry: true },
    };

  if (current.mode !== 'interactive') {
    if (result.fixDeliveryFailure)
      throw new ResultDecisionHoldError(result.fixDeliveryFailure, inputs, {
        ...result,
        cliCommand,
      });
    const benignSkipReasons = new Set([
      'disabled',
      'disabled-for-project',
      'worker-signal-trivial',
    ]);
    if (result.skipped && !benignSkipReasons.has(result.reason ?? '')) {
      throw new Error(`Self-review did not complete: ${result.reason ?? 'unknown'}`);
    }
    if (!result.skipped && result.verdict === 'blocked') {
      updateRun(runId, {
        status: 'blocked',
        metrics: {
          ...current.metrics,
          outcome: 'partial',
        },
        error: result.reason ?? 'Self-review fix blocked',
      });
    }
    if (!result.skipped && result.verdict === 'issues') {
      const issueCount = result.issues?.length ?? 0;
      const firstIssue = result.issues?.[0];
      const location = firstIssue
        ? `${firstIssue.file}${firstIssue.line ? `:${firstIssue.line}` : ''}`
        : 'unknown';
      const message = firstIssue?.description ?? 'Review found issues';
      // Persist review outputs (verdict, retryCount, maxRetries, issues) so
      // the failure step in the UI can render "MAX RETRIES" + the residual issues
      // instead of just "x". Without this stepPartialIO call the catch handler
      // writes failureOutputs without any review fields.
      stepPartialIO.set(runId, {
        inputs,
        outputs: {
          ...result,
          cliCommand,
          maxRetriesExhausted: true,
        },
      });
      const retriesLabel =
        result.maxRetries !== undefined
          ? ` after ${result.retryCount}/${result.maxRetries} fix attempts`
          : '';
      const reason = `Review found ${issueCount || 'one or more'} issue(s)${retriesLabel} in ${location}: ${message}`;
      // A delivered result waits for a person instead of failing (ADR-065 Amendment 7).
      if (runDeliveredResult(getRun(runId) ?? current))
        throw new ResultDecisionHoldError(reason, inputs, {
          ...result,
          cliCommand,
          maxRetriesExhausted: true,
        });
      throw new Error(reason);
    }
  }

  return {
    inputs: { ...inputs, enabled: !result.skipped },
    outputs: { ...result, cliCommand, ...(interactiveRetry ? { interactiveRetry: true } : {}) },
  };
}

/** Keep the worker tmux session alive while the publication human gate is open. */
export async function holdSlotForPublicationGate(
  slotId: string,
  broadcastFn: (event: string, payload: unknown) => void,
): Promise<void> {
  await markSlotBusy(slotId, 'review-gate', 'working');
  broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
}

/**
 * F42: when the evidence or HEAD changed after the last passing
 * review, review runs again before the publication gate is presented, once
 * per changed state: one that does not pass leaves review unsatisfied at the
 * gate instead of looping. Returns whether a review ran.
 */
export async function rerunReviewIfReviewedInputsChanged(
  runId: string,
  context: Pick<
    PostDispatchStepContext,
    'executePublishGateReviewPlan' | 'getDiffStat' | 'prepareCompletionPackageForRun'
  >,
): Promise<boolean> {
  const latest = getRun(runId);
  const reviewSlotId = latest?.slotId;
  if (!latest || !reviewSlotId) return false;
  const changedInputs = await reviewedInputsAwaitingReview(latest);
  if (!changedInputs) return false;
  const reviewedPackage = await readReadyGatePreparedPackage(latest);
  // Findings awaiting a fix come first: Continue Fixing re-reviews after the fix, and a review
  // now would spend the round on the same code (ADR-063 Amendment 4).
  if (
    publicationReviewBlockingReason(latest, reviewedPackage) ||
    (await gateReviewContinuationForRun(latest, reviewedPackage?.headSha))
  )
    return false;
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — evidence or HEAD changed since the last review; running review again`,
  );
  // ADR-063 Amendment 3: the recheck runs the row the pipeline review ran.
  const reviewStep = latest.steps.find((step) => step.name === S.REVIEW);
  const reviewSelection = reviewStep?.inputs?.reviewSelection;
  // Amendment 5: it continues that review's lineage, named by the pipeline result's session.
  const session = reviewStep?.outputs?.session;
  const pipelineReviewId =
    session && typeof session === 'object' && 'reviewId' in session ? session.reviewId : undefined;
  // The pipeline row wraps the lineage in its own id (pipeline-review-<lineage>).
  const pipelineReview =
    typeof pipelineReviewId === 'string'
      ? latestReviewOfLineage(latest.engineState?.publishGate?.reviews ?? [], pipelineReviewId)
      : undefined;
  const lineage =
    typeof pipelineReviewId === 'string' && reReviewOfStatus(pipelineReview)
      ? lineageContextForRun(latest, pipelineReviewId)
      : undefined;
  const mode = lineage ? 'warm' : resolveReviewMode();
  const plan: ReviewSelection[] = [
    reviewSelection
      ? { ...parseReviewSelection(reviewSelection), mode }
      : lineage && pipelineReview?.runner
        ? {
            runner: pipelineReview.runner,
            model: pipelineReview.model ?? null,
            effort: pipelineReview.effort ?? null,
            mode,
          }
        : { runner: 'claude', model: null, effort: null, mode },
  ];
  const reviewPlanResult = await context.executePublishGateReviewPlan(
    runId,
    reviewSlotId,
    plan,
    'dispatch',
    lineage ? { reviewSequenceContext: { reviewLineages: [lineage] } } : undefined,
  );
  await reconcilePublishGateReviewPlanResult(runId, plan, reviewPlanResult, context, {
    reviewedPackage,
    stampFreshReviews: true,
  });
  // Marked only once a review attempt settled: a restart or a launch that ran
  // nothing leaves the change pending, so the next presentation re-runs it.
  if (reviewPlanResult.reviewIds.length === 0) return false;
  // A pass already recorded what it was given. A re-run that did not pass marks
  // what its last attempt was given (after any fix loops), never the slot as it
  // is now: an edit made while it ran is still unreviewed.
  const after = getRun(runId)?.engineState;
  const lastReviewed = after?.reviewInputsAtLaunch;
  if (lastReviewed && lastReviewed !== after?.reviewedInputs?.fingerprint)
    await markReviewedInputsRerun(runId, lastReviewed);
  return true;
}

export async function executeHumanGateStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const {
    blockedRunError,
    broadcastFn,
    executeNoChangeGate,
    executePublishGateReviewPlan,
    executeReadyGate,
    executeReviewGate,
    getDiffStat,
    isHumanGateEnabled,
  } = context;
  const current = getRun(runId)!;
  const generation = current.engineState?.generation ?? 0;
  if (current.steps.some((step) => step.name === S.HUMAN_GATE && step.status === 'running'))
    updateRunStep(runId, S.HUMAN_GATE, { detail: 'Preparing operator decision' });
  if (current.engineState?.publishGate?.humanPublicationAdoption) {
    const { assertAdoptedPublicationContinuation } =
      await import('../run-completion/human-publication.js');
    await assertAdoptedPublicationContinuation(current);
    return {
      inputs: { publicationAdoption: current.engineState.publishGate.humanPublicationAdoption.id },
      outputs: { resolvedAction: 'superseded-by-publication-adoption' },
    };
  }
  const gateType = current.flowType === 'review-pr' ? 'review' : 'ready';
  const noChangeGate = shouldForceNoChangeHumanGate(current);
  const publicationApprovalGate = requiresPublicationApproval(current);
  const artifactOnly = isArtifactOnlyRun(current);
  if (isLightweightInteractiveDevRun(current)) {
    // Kept skipped. In the dev flow HUMAN_GATE runs AFTER COMPLETE
    // (MONITOR -> REVIEW -> COMPLETE -> HUMAN_GATE), so it is a publication
    // gate, not a completion gate — it cannot hold a run that has already
    // completed and released its slot. The operator hold for this profile is in
    // MONITOR, which parks a worker-authored terminal signal before COMPLETE can
    // run. Gating again here would re-prompt an operator who just chose their
    // completion action.
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — human-gate skipped for interactive lightweight dev policy`,
    );
    return {
      inputs: { gateType, gateEnabled: false, policy: 'interactive-lightweight' },
      outputs: {
        skipped: true,
        reason: 'interactive-lightweight-policy',
        source: 'operator-policy',
        externalReview: 'deferred',
      },
    };
  }
  if (artifactOnly) {
    if (current.flowType === 'review-pr') await recordArtifactOnlyReviewResult(runId);
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — human-gate skipped for artifact-only completion policy`,
    );
    return {
      inputs: { gateType, completionPolicy: current.completionPolicy },
      outputs: { skipped: true, reason: 'artifact-only-policy' },
    };
  }

  // Review publication is always operator-owned. Runner mode may change how
  // the review is produced, but it must never bypass the posting decision.
  const configuredGateEnabled = await isHumanGateEnabled(
    current.project,
    current.flowType,
    current.mode,
  );
  const gateEnabled = noChangeGate || current.flowType === 'review-pr' || configuredGateEnabled;
  const inputs: Record<string, unknown> = {
    gateType: noChangeGate ? 'no-change' : gateType,
    gateEnabled,
    forced: noChangeGate,
  };

  if (!gateEnabled) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — human-gate skipped (disabled for ${current.flowType})`,
    );
    return {
      inputs,
      outputs: { skipped: true, reason: `human-gate-disabled-for-${current.flowType}` },
    };
  }

  // Update slot lifecycle so UI shows the slot is waiting for review while the
  // worker runner stays attachable for operator Q&A.
  if (current.slotId) {
    await markSlotBusy(current.slotId, 'review-gate', 'working');
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
  }

  // Gate re-entry (restart recovery, step replay) presents a fresh decision;
  // a pending one left by a dead engine loop must be closed first so exactly
  // one live gate decision can receive the approval.
  const supersededGateDecisions = supersedeStaleHumanGateDecisions(current.decisions);
  if (supersededGateDecisions > 0) {
    updateRun(runId, { decisions: current.decisions });
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — superseded ${supersededGateDecisions} stale human-gate decision(s) on gate entry`,
    );
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  }

  // Track wait duration
  const gateStart = Date.now();

  // Dispatch to flow-specific gate logic
  if (noChangeGate) {
    await executeNoChangeGate(runId);
  } else if (current.flowType === 'review-pr') {
    await executeReviewGate(runId);
  } else {
    if (publicationApprovalGate && !shouldResumePublicationGate(current)) {
      // Restart mid-review recovery: a gateway restart during a publish-gate
      // review's await abandons the completed reviewer's result. Re-entering the
      // human gate, ingest any finished-but-lost reviews before re-presenting so
      // a completed review is never silently discarded.
      let recoveredReviewIds: string[] = [];
      if (current.slotId) {
        normalizeExhaustedReviewContinuationsForRun(runId);
        const recoveryResult = await recoverInflightPublicationReviews(runId, current.slotId);
        recoveredReviewIds = recoveryResult.recoveredIds;
        if (recoveredReviewIds.length) {
          console.log(
            `[run-engine] run ${runId.slice(0, 8)} — recovered ${recoveredReviewIds.length} in-flight publication review(s) after restart`,
          );
        }
        if (recoveryResult.terminalErrors.length > 0) {
          throw new TerminalReviewArtifactError(
            recoveryResult.terminalErrors.map((error) => error.message).join('; '),
          );
        }
      }
      // Do not auto-send leftover extra-review findings on human-gate entry.
      // Restart used to resumeInterruptedPublicationReview here, which re-fed
      // the same ISSUES into the worker with no pending decision — Command
      // Center had nothing to click. Continue Fixing stays an operator action.
      // Runs persisted before review counting v2 may re-enter directly at the
      // human gate after restart. Repair before deriving an automatic plan so
      // the legacy double-count does not launch a redundant reviewer.
      let beforeInitialPlan = getRun(runId)!;
      const gateHeadSha = (await readReadyGatePreparedPackage(beforeInitialPlan))?.headSha;
      const repairedPlan = repairUnboundRecoveryReviewPlan(beforeInitialPlan, gateHeadSha);
      if (repairedPlan) {
        updateRun(runId, {
          engineState: {
            ...beforeInitialPlan.engineState,
            publishGate: {
              ...beforeInitialPlan.engineState?.publishGate,
              reviewSequence: repairedPlan.sequence,
              reviewSequenceContext: repairedPlan.context,
              reviewSequenceRequestedAt: repairedPlan.requestedAt,
            },
          },
        });
        updateRunStep(runId, S.HUMAN_GATE, {
          detail: repairedPlan.note,
          outputs: {
            ...beforeInitialPlan.steps.find((step) => step.name === S.HUMAN_GATE)?.outputs,
            reviewRecoveryNote: repairedPlan.note,
          },
        });
        beforeInitialPlan = getRun(runId)!;
      }
      const explicitInitialPlan = beforeInitialPlan.engineState?.publishGate?.reviewSequence ?? [];
      // Operator may have already resolved request-review (e.g. codex) while
      // the engine had no live createEngineDecision waiter. Resume must honor that
      // unconsumed selection — not invent automaticPublicationReviewPlan (which
      // picks defaultAlternate for the worker and re-launched claude for a grok
      // worker on run 71803bd2 after a codex request).
      const unconsumedReviewDecision = (beforeInitialPlan.decisions ?? [])
        .filter(
          (decision) =>
            decision.type === 'engine_human_gate' &&
            !!decision.resolvedAt &&
            isHumanGateReviewRequestAction(decision.resolvedAction) &&
            typeof decision.context?.reviewRequestConsumedAt !== 'string',
        )
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
      const fromUnconsumed = unconsumedReviewDecision
        ? resolveHumanGateReviewExecutionPlan({
            gateAction: unconsumedReviewDecision.resolvedAction ?? 'request-review',
            pendingPlan: explicitInitialPlan,
            decisions: beforeInitialPlan.decisions ?? [],
          })
        : [];
      const reviewsForInitial = beforeInitialPlan.engineState?.publishGate?.reviews ?? [];
      const latestHasOpenFindings = Boolean(
        publicationReviewBlockingReason(beforeInitialPlan, { headSha: gateHeadSha }),
      );
      const persistedReviewPolicy = beforeInitialPlan.engineState?.publishGate?.reviewPolicy;
      const replayProjectVars =
        (unconsumedReviewDecision && persistedReviewPolicy?.requestedBy !== 'dispatch') ||
        (!unconsumedReviewDecision && !explicitInitialPlan.length && !latestHasOpenFindings)
          ? await loadProjectVarsOrNull(
              beforeInitialPlan.project,
              'publication review replay',
              beforeInitialPlan.id,
            )
          : null;
      const replayBaseReviewPolicy =
        persistedReviewPolicy?.requestedBy === 'dispatch'
          ? persistedReviewPolicy
          : publicationReviewPolicyForRun(beforeInitialPlan, replayProjectVars?.projectJson);
      const explicitPlanSource =
        beforeInitialPlan.engineState?.publishGate?.reviewPolicy?.requestedBy === 'human-gate'
          ? 'human-gate'
          : 'dispatch';
      // ADR-063 Amendment 3: the pipeline review ran the dispatch's row 1. Its pass
      // of the gate head is a COLD row 1's result; at an older head row 1 runs again.
      const pipelineReviewedFirstRow =
        explicitPlanSource === 'dispatch' &&
        pipelineReviewSatisfiesFirstRow(explicitInitialPlan, reviewsForInitial, {
          headSha: gateHeadSha,
          requestedAt: beforeInitialPlan.engineState?.publishGate?.reviewSequenceRequestedAt,
        });
      // A restart can land after a reviewer verdict was persisted but before
      // the durable pending plan was cleared. Execute only the still-missing
      // portion; otherwise every restart launches another already-satisfied
      // reviewer (and a two-loop plan can replay loop one twice).
      const initialPlan = unconsumedReviewDecision
        ? remainingExplicitReviewPlan(fromUnconsumed, reviewsForInitial, {
            requestedAt: unconsumedReviewDecision?.resolvedAt,
            source: 'human-gate',
          })
        : latestHasOpenFindings
          ? []
          : explicitInitialPlan.length
            ? remainingExplicitReviewPlan(
                pipelineReviewedFirstRow ? explicitInitialPlan.slice(1) : explicitInitialPlan,
                reviewsForInitial,
                {
                  requestedAt:
                    beforeInitialPlan.engineState?.publishGate?.reviewSequenceRequestedAt,
                  source: explicitPlanSource,
                },
              )
            : automaticPublicationReviewPlan(
                beforeInitialPlan.engineState?.publishGate?.reviewPolicy ??
                  publicationReviewPolicyForRun(beforeInitialPlan),
                reviewsForInitial,
                resolveReviewDispatchDefaults(
                  {
                    name: beforeInitialPlan.project,
                    defaults: replayProjectVars?.projectJson.defaults,
                    review: replayProjectVars?.projectJson.review,
                  },
                  'review-pr',
                ),
              );
      const initialContext = unconsumedReviewDecision?.selectionData?.reviewRequest
        ? reviewContextFromRequest(unconsumedReviewDecision.selectionData.reviewRequest)
        : beforeInitialPlan.engineState?.publishGate?.reviewSequenceContext;
      const originalSequenceLength = unconsumedReviewDecision
        ? fromUnconsumed.length
        : explicitInitialPlan.length;
      const initialReviewSequenceContext = initialContext
        ? {
            reviewLineages: initialContext.reviewLineages.slice(
              Math.max(0, originalSequenceLength - initialPlan.length),
            ),
          }
        : undefined;
      const recoveredReviewPolicy = unconsumedReviewDecision
        ? humanGateReviewPolicy(
            replayBaseReviewPolicy,
            humanGateReviewRequestFromDecision(unconsumedReviewDecision),
            {
              actionId: unconsumedReviewDecision.resolvedAction,
              fallbackLoopCount: Math.max(1, fromUnconsumed.length),
            },
          )
        : undefined;
      if (
        (explicitInitialPlan.length > 0 || fromUnconsumed.length > 0) &&
        initialPlan.length === 0
      ) {
        updateRun(runId, {
          engineState: {
            ...beforeInitialPlan.engineState,
            publishGate: {
              ...beforeInitialPlan.engineState?.publishGate,
              ...(recoveredReviewPolicy ? { reviewPolicy: recoveredReviewPolicy } : {}),
              reviewSequence: [],
              reviewSequenceContext: undefined,
              reviewSequenceRequestedAt: undefined,
            },
          },
        });
        if (unconsumedReviewDecision) {
          markResolvedHumanGateReviewRequestConsumed(unconsumedReviewDecision);
          updateRun(runId, { decisions: beforeInitialPlan.decisions });
        }
      }
      if (initialPlan.length) {
        // A row the pipeline review satisfied leaves the stored plan and its lineages.
        if (
          explicitInitialPlan.length === 0 ||
          unconsumedReviewDecision ||
          pipelineReviewedFirstRow
        ) {
          updateRun(runId, {
            engineState: {
              ...beforeInitialPlan.engineState,
              publishGate: {
                ...beforeInitialPlan.engineState?.publishGate,
                ...(recoveredReviewPolicy ? { reviewPolicy: recoveredReviewPolicy } : {}),
                reviewSequence: initialPlan,
                reviewSequenceContext: initialReviewSequenceContext,
                reviewSequenceRequestedAt: new Date().toISOString(),
              },
            },
          });
        }
        if (unconsumedReviewDecision) {
          markResolvedHumanGateReviewRequestConsumed(unconsumedReviewDecision);
          updateRun(runId, { decisions: getRun(runId)!.decisions });
        }
        const dispatchReviewSlotId = current.slotId;
        if (!dispatchReviewSlotId)
          throw new Error('No slot assigned — cannot run dispatch publish-gate reviews');
        const dispatchPlan = initialPlan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
        const reviewSource =
          unconsumedReviewDecision ||
          getRun(runId)?.engineState?.publishGate?.reviewPolicy?.requestedBy === 'human-gate'
            ? 'human-gate'
            : 'dispatch';
        // A gate restart recovery replayed re-enters with the operator's persisted
        // policy, but its launches are automatic: the no-verdict cap applies.
        const activeRecoveryAttempt = getRun(runId)?.recoveryAttempts?.at(-1);
        const recoveryReplay =
          activeRecoveryAttempt?.stepName === S.HUMAN_GATE &&
          activeRecoveryAttempt.status === 'started' &&
          activeRecoveryAttempt.triggeredBy === 'auto-recovery';
        const reviewPlanResult = await executePublishGateReviewPlan(
          runId,
          dispatchReviewSlotId,
          dispatchPlan,
          reviewSource,
          {
            automaticLaunch:
              !unconsumedReviewDecision && (reviewSource !== 'human-gate' || recoveryReplay),
          },
        );
        await reconcilePublishGateReviewPlanResult(runId, dispatchPlan, reviewPlanResult, context);
      } else if (recoveredReviewIds.length > 0) {
        const beforeRefresh = await readReadyGatePreparedPackage(getRun(runId)!);
        const diffStat = await getDiffStat(getRun(runId)!);
        const prepared = await prepareGatePackageAfterReviews(runId, () =>
          prepareCompletionPackage(runId, {
            diffStat,
            reviewPolicy: getRun(runId)?.engineState?.publishGate?.reviewPolicy,
            publicationTarget: getRun(runId)?.engineState?.publishGate?.publicationTarget,
            selectedEvidenceKeys: beforeRefresh?.selectedEvidenceKeys,
            priorEvidenceManifest: beforeRefresh?.evidenceManifest,
            stampReviews: false,
            requireArtifactMirror: true,
          }),
        );
        if (prepared)
          stampFreshReviewsForPreparedPackage(runId, recoveredReviewIds, prepared.prPackage);
      }
    }
    const presentReadyGate = async (): Promise<string> => {
      updateRunStep(runId, S.HUMAN_GATE, { detail: 'Preparing operator decision' });
      // A refused approval reopens only the wait. A later explicit review request
      // or Continue Fixing decision still follows its existing owner below.
      if (publicationApprovalGate && !shouldResumePublicationGate(getRun(runId)!))
        await rerunReviewIfReviewedInputsChanged(runId, context);
      return executeReadyGate(runId);
    };
    // A repair interrupted by a restart resumes under its single charge: fix recovery adopts an
    // in-flight or deferred delivery, and an undelivered one is delivered once.
    const repairSlotIdAtEntry = getRun(runId)?.slotId ?? current.slotId;
    if (repairSlotIdAtEntry && activeVisualRepair(getRun(runId)!))
      await (context.resumeVisualRepairForRun ?? resumeVisualRepair)(runId, repairSlotIdAtEntry);
    let gateAction = await presentReadyGate();
    while (
      publicationApprovalGate &&
      !isPublishApprovalAction(gateAction) &&
      gateAction !== 'superseded-by-publication-adoption' &&
      gateAction !== CLOSE_AS_SHIPPED_ACTION
    ) {
      if (gateAction === 'hold') {
        gateAction = await presentReadyGate();
        continue;
      }
      if (gateAction === CONTINUE_REVIEW_FIX_ACTION) {
        const continuationSlotId = getRun(runId)?.slotId ?? current.slotId;
        if (!continuationSlotId) {
          throw blockedRunError(
            'Publication review findings cannot continue without an assigned slot',
            gateAction,
          );
        }
        await (
          context.resumeInterruptedPublicationReviewForRun ?? resumeInterruptedPublicationReview
        )(runId, continuationSlotId);
        // A runner or delivery refusal preserves the findings. Re-present the gate
        // so recovery can retry after the infrastructure failure is fixed.
        gateAction = await presentReadyGate();
        continue;
      }
      if (gateAction === SEND_BACK_TO_AGENT_ACTION) {
        const repairSlotId = getRun(runId)?.slotId ?? current.slotId;
        // A refused or undelivered repair keeps its single charge; the gate is always re-presented.
        if (repairSlotId)
          await (context.resumeVisualRepairForRun ?? resumeVisualRepair)(runId, repairSlotId);
        gateAction = await presentReadyGate();
        continue;
      }
      if (gateAction === 'request-review') {
        const beforeReviewPlan = getRun(runId)!;
        const reviewedPackage = await readReadyGatePreparedPackage(beforeReviewPlan);
        // Prefer the latest request-review
        // decision's selectionData over a stale pending plan. Pending alone
        // previously won, so a second request that changed runner (claude→codex)
        // could still launch the old runner. Approval-only decision lookup was
        // also wrong as a fallback — it never sees review-request decisions.
        const plan = resolveHumanGateReviewExecutionPlan({
          gateAction,
          pendingPlan: beforeReviewPlan.engineState?.publishGate?.reviewSequence ?? [],
          decisions: beforeReviewPlan.decisions ?? [],
        });
        // Each operator request is already bounded. Do not apply a second
        // cumulative ceiling across the lifetime of a human gate: a long-lived
        // incremental review loop may legitimately need more requests, and
        // rejecting an accepted decision here terminally blocks the run.
        const boundedPlan = plan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
        if (!boundedPlan.length) {
          gateAction = await presentReadyGate();
          continue;
        }
        const reviewSlotId = current.slotId;
        if (!reviewSlotId)
          throw blockedRunError(
            'Publication gate requested an review but no slot is assigned',
            gateAction,
          );
        const reviewPlanResult = await executePublishGateReviewPlan(
          runId,
          reviewSlotId,
          boundedPlan,
          'human-gate',
        );
        await reconcilePublishGateReviewPlanResult(runId, boundedPlan, reviewPlanResult, context, {
          reviewedPackage,
          stampFreshReviews: true,
        });
        gateAction = await presentReadyGate();
        continue;
      }
      throw blockedRunError(`Publication gate blocked by action: ${gateAction}`, gateAction);
    }
  }

  if (runSupersededSince(getRun(runId), generation))
    return { inputs, outputs: { resolvedAction: 'abort' } };

  const waitDurationMs = Date.now() - gateStart;

  // Restore slot lifecycle after gate resolution; worker stays alive until finalize.
  if (current.slotId) {
    await markSlotBusy(current.slotId, 'working', 'working');
    broadcastFn(Events.FLEET_UPDATED, { fleet: await loadFleetStatus(true) });
  }

  const after = getRun(runId)!;
  const lastDecision = after.decisions[after.decisions.length - 1];
  const gatePayloadSummary = lastDecision?.payload ? `${lastDecision.payload.kind}` : undefined;
  return {
    inputs,
    outputs: {
      resolvedAction: lastDecision?.resolvedAction ?? null,
      waitDurationMs,
      gatePayloadSummary,
    },
  };
}

/** Whether `step` is the last step of `flowType`, so finishing it ends the run. */
export function isFlowTerminalStep(flowType: Run['flowType'], step: string): boolean {
  const steps = FLOW_STEPS[flowType];
  return steps[steps.length - 1] === step;
}

export async function executeCompleteStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { broadcastFn, getDiffStat, refreshRunLinks } = context;
  let current = getRun(runId)!;
  let inheritedAcceptance: InheritedAcceptanceProvenance | undefined;
  let acceptanceIdentity:
    | import('../run-completion/pr-completion-proof.js').PRCompletionTransactionIdentity
    | undefined;
  const generation = current.engineState?.generation ?? 0;
  if (current.engineState?.publishGate?.humanPublicationAdoption) {
    const { assertAdoptedPublicationContinuation } =
      await import('../run-completion/human-publication.js');
    await assertAdoptedPublicationContinuation(current);
    return {
      inputs: { publicationAdoption: current.engineState.publishGate.humanPublicationAdoption.id },
      outputs: {
        publicationStatus: current.engineState.publishGate.publicationStatus,
        prNumber: current.prNumber,
      },
    };
  }
  if (!current.slotId) throw new Error('No slot assigned');
  // Record the verified Git result independently of acceptance/publication approval.
  if (current.acceptanceRegistration?.units.some(({ result }) => !result)) {
    const { continuePRCompletionStep } = await import('../methods/run/replay-step.js');
    const continuation = await continuePRCompletionStep(
      runId,
      'monitor',
      broadcastFn,
      async () =>
        (getRun(runId)?.engineState?.generation ?? 0) === generation &&
        Boolean(getRun(runId)?.acceptanceRegistration?.units.some(({ result }) => !result)),
    );
    if (continuation.continued)
      return {
        inputs: { flowType: current.flowType },
        outputs: { acceptanceDerivationPending: true },
      };
    current = continuation.run;
  }
  // A refused completion must not strand a successful push behind stale ownership.
  const noCodeDisposition = isNoCodeTerminalDisposition(current.metrics.disposition);
  if (noCodeDisposition || ['blocked', 'failed'].includes(current.metrics.disposition ?? ''))
    await abandonBranchMaintenance(current);
  else await completeBranchMaintenance(current);
  if (!shouldPrepareLocalFirstPackage(current)) {
    // SIGNAL.json can precede the worker's final native turn completion. Keep
    // this engine attempt alive while that is the only unmet prerequisite.
    for (;;) {
      const latest = getRun(runId);
      if (runSupersededSince(latest, generation))
        throw new Error('Completion was superseded while waiting for worker idle');
      current = latest!;
      try {
        const readiness = await (context.assertGatePrerequisites ?? assertRunGateReady)(
          current,
          null,
          'complete',
        );
        if (current.flowType === 'pr-complete' && current.acceptanceContractVersion === 1) {
          acceptanceIdentity = {
            generation: readiness.identity.generation,
            registrationRevision: readiness.identity.acceptanceRevision ?? 0,
            contractRevision: readiness.identity.acceptanceContractRevision ?? 0,
            headSha:
              readiness.identity.headSha ??
              (await (context.prCompletionHead ?? readPRCompletionHead)(current)),
          };
        }
        if (current.parentRunId) {
          const { readInheritedAcceptanceSource } =
            await import('../run-completion/inherited-acceptance.js');
          inheritedAcceptance = (await readInheritedAcceptanceSource(current))?.provenance;
        }
        break;
      } catch (error) {
        if (runSupersededSince(getRun(runId), generation))
          throw new Error('Completion was superseded during gate validation');
        if (!(error instanceof RunGateNotReadyError) || !error.workProgressingOnly) throw error;
        updateRunStep(runId, S.COMPLETE, {
          detail: 'Waiting for worker to finish its native turn...',
        });
        broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
        await (context.waitForCompletionProgress?.() ?? delay(1_000));
      }
    }
  }
  // Revalidate on completion/replay so a checklist or force-skipped monitor cannot supply QA proof.
  if (!current.slotId) throw new Error('No slot assigned');
  if (current.flowType === 'qa') await assertQaCompletion(current);
  if (runSupersededSince(getRun(runId), generation))
    throw new Error('Completion was superseded during gate validation');
  const artifactOnly = isArtifactOnlyRun(current);
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    flowType: current.flowType,
    noCodeDisposition,
    artifactOnly,
  };
  if (current.flowType !== 'review-pr') await captureReviewInputArtifactsForRun(current);

  const hasCIWatch = shouldSkipRetrospectiveAtComplete(current);
  const skipRetrospective = hasCIWatch;

  // Run completion (artifact copy, PR comment, title, labels). Must run
  // BEFORE getDiffStat because branch discovery happens inside it. Worker
  // artifact copy excludes gateway-owned diff artifacts, so getDiffStat
  // below preserves any READY_GATE snapshot instead of copy-back data.
  updateRunStep(runId, S.COMPLETE, { detail: 'Completing...' });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  if (shouldPrepareLocalFirstPackage(current)) {
    updateRunStep(runId, S.COMPLETE, { detail: 'Preparing local PR package...' });
    const diffStat = await getDiffStat(current);
    const prepared = await prepareCompletionPackage(runId, {
      diffStat,
      requireArtifactMirror: true,
    });
    await holdSlotForPublicationGate(current.slotId, broadcastFn);
    const cliCommand = `farmslot slot check ${current.slotId}`;
    return {
      inputs,
      outputs: {
        prNumber: null,
        ciRepo: prepared.completion.ciRepo,
        artifactsCopied: prepared.completion.artifactsCopied,
        prCommentPosted: false,
        prTitleUpdated: false,
        prMarkedReady: false,
        retrospectiveCreated: false,
        slotDisposition: 'gate-held',
        artifacts: prepared.completion.artifacts,
        cliCommand,
        diffStat,
        packageId: prepared.prPackage.id,
        packageHash: prepared.prPackage.packageHash,
        packageArtifactPath: prepared.prPackage.artifactPath,
        publicationTarget: prepared.prPackage.publicationTarget,
        publicationStatus: prepared.prPackage.publicationStatus,
        reviewPolicy: prepared.reviewPolicy,
        reviews: prepared.reviews,
        reviewSatisfied: reviewPolicySatisfied(prepared.reviewPolicy, prepared.reviews),
      },
    };
  }
  const completion = await runCompletionPipeline(runId, {
    acceptanceIdentity,
    skipRetrospective,
    suppressPrMutation: noCodeDisposition || artifactOnly,
    inheritedAcceptance,
  });
  await refreshRunLinks(runId);
  if (completion.prNumber && current.flowType !== 'review-pr') {
    await captureReviewInputArtifactsForRun(getRun(runId) ?? current);
  }

  const runBeforeDiff = getRun(runId) ?? current;
  if (runBeforeDiff.engineState?.evalExperiment) {
    await executeEvalHarnessLifecycle(runBeforeDiff, 'cleanup');
    await captureRunOutput(runId);
    if (runBeforeDiff.engineState.evalExperiment.blind) await freezeBlindTrialFirstOutput(runId);
  }

  // diffStat needs the slot's git tree; runs before slotRelease below.
  const diffStat = await getDiffStat(getRun(runId) ?? current);
  const finalizedEvalPackage = await finalizeEvalResultPackageForRun(getRun(runId) ?? current);
  let slotDisposition: 'ci-watch' | 'released' | 'release-deferred' | 'kept-shared-slot';

  if (!noCodeDisposition && hasCIWatch && completion.prNumber && completion.ciRepo) {
    // Keep slot alive for CI monitoring — worker is done so clear agent
    await markSlotHeld(current.slotId, 'ci-watch');
    console.log(`[run-engine] run ${runId.slice(0, 8)} — slot ${current.slotId} → ci-watch`);
    slotDisposition = 'ci-watch';
  } else {
    // No CI watch (review-pr) or no PR found — release slot
    const release: SlotReleaseParams = {
      slotId: current.slotId,
      keepWork: true,
      detachRuns: false,
      expectedRunId: current.id,
    };
    // Deferred only when COMPLETE is the flow's last step. There the release was
    // gating the run's own `done` status on tmux teardown (ADR-053), so the
    // engine runs it after publication instead. A flow that continues past
    // COMPLETE — human gate, finalize, ci-watch — still needs the slot freed
    // now, because the run is not terminal and later steps read slot state.
    if (isFlowTerminalStep(current.flowType, S.COMPLETE)) {
      context.deferTerminalSlotRelease(release);
      // Reported honestly: the step decided the disposition, the engine performs
      // it after the run publishes. Recording 'released' here claimed a teardown
      // that has not happened, in the step I/O an operator reads.
      slotDisposition = 'release-deferred';
    } else {
      const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');
      slotDisposition = (await releaseCompletedRunSlot(current)).released
        ? 'released'
        : 'kept-shared-slot';
    }
  }
  const cliCommand = `farmslot slot release ${current.slotId} --keep-warm`;
  return {
    inputs,
    outputs: {
      prNumber: completion.prNumber,
      ciRepo: completion.ciRepo,
      publishedHeadSha: completion.publishedHeadSha,
      artifactsCopied: completion.artifactsCopied,
      prCommentPosted: completion.prCommentPosted,
      prTitleUpdated: completion.prTitleUpdated,
      prMarkedReady: completion.prMarkedReady,
      retrospectiveCreated: completion.retrospectiveCreated,
      ...(completion.inheritedAcceptance
        ? { inheritedAcceptance: completion.inheritedAcceptance }
        : {}),
      slotDisposition,
      artifacts: completion.artifacts,
      cliCommand,
      diffStat,
      resultPackage: finalizedEvalPackage
        ? {
            packageId: finalizedEvalPackage.packageId,
            packageHash: finalizedEvalPackage.packageHash,
          }
        : undefined,
    },
  };
}
