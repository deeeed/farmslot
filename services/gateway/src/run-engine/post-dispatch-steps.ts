import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  type DiffStat,
  Events,
  FLOW_STEPS,
  isLightweightInteractiveDevRun,
  isPublishEvidenceArtifact,
  PipelineSteps,
  type ReadyGatePrPackage,
  type ReviewLoopRequest,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { markSlotBusy, markSlotHeld, updateSlotStatus } from '../core/index.js';
import {
  finalizeEvalResultPackageForRun,
  readResultPackageManifest,
} from '../evals/package-store.js';
import { loadFleetStatus } from '../fleet/state.js';
import { slotRelease } from '../methods/slot.js';
import { independentReviewPolicySatisfied } from '../quality/review-policy.js';
import { refreshArtifactMirror } from '../run-completion/artifact-mirror.js';
import { evidenceKeyVariants } from '../run-completion/evidence-paths.js';
import {
  isArtifactOnlyRun,
  prepareCompletionPackage,
  runCompletionPipeline,
} from '../run-completion/orchestrator.js';
import {
  computeReadyGateReviewSubjectHash,
  readReadyGatePreparedPackage,
} from '../run-completion/ready-gate-package.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { executeSelfReview } from '../self-review/orchestrator.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

import { captureReviewInputArtifactsForRun } from './diff-artifacts.js';
import { executeEvalHarnessLifecycle } from './eval-harness-lifecycle.js';
import {
  CLOSE_AS_SHIPPED_ACTION,
  isPublishApprovalAction,
  reviewFinalSnapshotMatchesPreparedPackage,
  shouldForceNoChangeHumanGate,
  stampPublishGateReviewStatusForPackage,
} from './gate-policy.js';
import {
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from './publication-policy.js';
import { verifyWorkerPushedBranch } from './push-verification.js';
import { type MonitorResult, monitorRun } from './run-monitor.js';

interface StepIO {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
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
  activeMonitors: Map<string, AbortController>;
  blockedRunError: (message: string, reason: string) => Error;
  broadcastFn: BroadcastFn;
  createEngineDecision: (
    runId: string,
    reason: string,
    description: string,
    actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }>,
  ) => Promise<string>;
  executeNoChangeGate: (runId: string) => Promise<void>;
  executePublishGateReviewPlan: (
    runId: string,
    slotId: string,
    plan: ReviewLoopRequest[],
    trigger: 'dispatch' | 'human-gate',
  ) => Promise<string[]>;
  executeReadyGate: (runId: string) => Promise<string>;
  executeReviewGate: (runId: string) => Promise<void>;
  getDiffStat: (run: Run) => Promise<DiffStat>;
  interactiveLightweightSkipOutputs: (step: string) => StepIO;
  isHumanGateEnabled: (
    project: string,
    flowType: Run['flowType'],
    mode: Run['mode'],
  ) => Promise<boolean>;
  latestResolvedHumanGateDecision: (
    decisions: RunDecision[],
    approvalOnly?: boolean,
  ) => RunDecision | undefined;
  monitorTerminalError: (args: MonitorTerminalErrorArgs) => Error;
  refreshRunLinks: (runId: string) => Promise<void>;
  reviewPlanFromSelection: (selection: RunDecision['selectionData']) => ReviewLoopRequest[];
  stepPartialIO: Map<string, StepIO>;
}

const S = PipelineSteps;

export function shouldSkipRetrospectiveAtComplete(run: Pick<Run, 'flowType'>): boolean {
  // CI-watch is the terminal PR lifecycle step for publishable flows. Defer the
  // retrospective there so the card captures the whole family outcome instead
  // of the pre-CI completion snapshot. Human-gate alone is not terminal; review
  // flows without CI still need a retrospective after their complete step.
  return FLOW_STEPS[run.flowType].includes(S.CI_WATCH);
}
const MAX_PUBLISH_GATE_REVIEW_LOOPS = 5;
const MAX_HUMAN_GATE_REVIEW_REQUEST_LOOPS = 3;

function stampFreshReviewsForPreparedPackage(
  runId: string,
  reviewIds: string[],
  prPackage: Pick<ReadyGatePrPackage, 'headSha' | 'packageInputHash' | 'reviewSubjectHash'>,
): void {
  if (reviewIds.length === 0) return;
  const reviewIdSet = new Set(reviewIds);
  const latest = getRun(runId)!;
  const reviews = latest.engineState?.publishGate?.independentReviews ?? [];
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
        independentReviews: stampedReviews,
      },
    },
  });
}

async function evalReviewAxisSkip(run: Run): Promise<{
  skipped: boolean;
  axis?: unknown;
  reason?: string;
}> {
  const packagePath = run.engineState?.evalExperiment?.packagePath;
  if (!packagePath) return { skipped: false };
  const resultPackage = await readResultPackageManifest(packagePath);
  const reviewAxis = resultPackage.axes.review;
  const reviewModes = [reviewAxis?.name, reviewAxis?.version]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  const skippedMode = reviewModes.find((value) =>
    ['none', 'skip', 'disabled', 'first-pass'].includes(value),
  );
  if (!skippedMode) {
    return { skipped: false, axis: reviewAxis };
  }
  return { skipped: true, axis: reviewAxis, reason: `eval-review-axis-${skippedMode}` };
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
  if (JSON.stringify(reviewedPackage.diffStat) !== JSON.stringify(preparedPackage.diffStat))
    return false;
  if (reviewedPackage.draftTitle !== preparedPackage.draftTitle) return false;
  if (reviewedPackage.draftBody !== preparedPackage.draftBody) return false;
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

export async function executeMonitorStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { activeMonitors, monitorTerminalError } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const inputs: Record<string, unknown> = { slotId: current.slotId };
  const controller = new AbortController();
  activeMonitors.set(runId, controller);
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
    // Worker is done — clear agent status
    await updateSlotStatus(current.slotId, { agent: 'idle' });
    const after = getRun(runId)!;
    const workerSignal = monitorResult?.workerSignal ?? null;
    if (workerSignal?.disposition || workerSignal?.evidence || workerSignal?.checklistTiming) {
      updateRun(runId, {
        metrics: {
          ...after.metrics,
          ...(workerSignal.disposition ? { disposition: workerSignal.disposition } : {}),
          ...(workerSignal.evidence ? { terminalEvidence: workerSignal.evidence } : {}),
          // Persist per-step timing so it survives task-dir pruning and feeds the gate summary.
          ...(workerSignal.checklistTiming
            ? { checklistTiming: workerSignal.checklistTiming }
            : {}),
        },
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
    if (workerSignal?.status === 'blocked' || workerSignal?.status === 'failed') {
      // The step itself completed — the worker self-signaled a terminal disposition. Throw
      // a typed error so the exception-driven catch handles status mutation + slot reset
      // in one place; the catch marks this step `done` (not failed) using stepOutputs.
      throw monitorTerminalError({
        status: workerSignal.status,
        outcome: workerSignal.status === 'blocked' ? 'partial' : 'failure',
        reason: workerSignal.reason ?? after.error ?? `worker signaled ${workerSignal.status}`,
        stepInputs: inputs,
        stepOutputs,
      });
    }
    if (workerSignal?.status === 'complete' || workerSignal?.status === 'done') {
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

export async function executeSelfReviewStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { createEngineDecision, interactiveLightweightSkipOutputs, stepPartialIO } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const inputs: Record<string, unknown> = { slotId: current.slotId, enabled: true };

  const reviewSkip = await evalReviewAxisSkip(current);
  if (reviewSkip.skipped) {
    console.log(`[run-engine] run ${runId.slice(0, 8)} — self-review skipped by eval review axis`);
    return {
      inputs: { ...inputs, enabled: false, reviewAxis: reviewSkip.axis },
      outputs: {
        skipped: true,
        reason: reviewSkip.reason,
        reviewAxis: reviewSkip.axis,
      },
    };
  }

  if (isLightweightInteractiveDevRun(current)) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — self-review skipped for interactive lightweight dev policy`,
    );
    const skipped = interactiveLightweightSkipOutputs(S.SELF_REVIEW);
    return { inputs: { ...inputs, ...skipped.inputs }, outputs: skipped.outputs };
  }

  if (isNoCodeTerminalDisposition(current.metrics.disposition)) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — self-review skipped for no-code disposition ${current.metrics.disposition}`,
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

  // update-branch: check worker's signal to decide if self-review is needed
  if (current.flowType === 'update-branch') {
    try {
      const vars = await loadSlotVars(current.slotId);
      const taskDir = current.taskFile ? path.dirname(current.taskFile) : null;
      if (taskDir) {
        const signalPath = isLocal(vars.host, vars.machine)
          ? path.join(vars.remoteRepo, taskDir, 'SIGNAL.json')
          : null;
        if (signalPath) {
          const signal = JSON.parse(await readFile(signalPath, 'utf-8'));
          if (signal.needsSelfReview === false) {
            console.log(
              `[run-engine] run ${runId.slice(0, 8)} — update-branch worker says self-review not needed (trivial conflicts)`,
            );
            return {
              inputs: { ...inputs, enabled: false },
              outputs: { skipped: true, reason: 'worker-signal-trivial' },
            };
          }
        }
      }
    } catch (err) {
      // Signal not found or unreadable — default to running self-review
      console.warn(
        `[run-engine] update-branch worker signal unavailable for ${runId.slice(0, 8)}; running self-review: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }

  const result = await executeSelfReview(runId, current.slotId);
  const cliCommand = `farmslot rpc self-review.run '{"runId":"${runId}"}'`;

  // Interactive mode: present self-review results as a decision before proceeding
  // In autonomous mode, executeSelfReview already handles feedback + retry internally
  if (current.mode === 'interactive' && !result.skipped && result.verdict === 'issues') {
    const issueCount = result.issues?.length ?? 0;
    const issueList =
      result.issues
        ?.map((i) => `- **${i.file}${i.line ? ':' + i.line : ''}**: ${i.description}`)
        .join('\n') ?? '';
    const desc = `Self-review found ${issueCount} issue${issueCount !== 1 ? 's' : ''}.\n\n${issueList}`;
    const actionId = await createEngineDecision(runId, 'self_review_complete', desc, [
      { id: 'send_feedback', label: 'Send feedback to worker', style: 'primary' },
      { id: 'skip', label: 'Skip — proceed to human gate', style: 'secondary' },
    ]);
    // When human chooses "send_feedback", re-run self-review which will
    // send feedback and wait for fix (existing retry logic)
    if (actionId === 'send_feedback') {
      const retryResult = await executeSelfReview(runId, current.slotId);
      return {
        inputs: { ...inputs, enabled: true },
        outputs: {
          ...retryResult,
          cliCommand,
          interactiveRetry: true,
        },
      };
    }
    // "skip" — proceed with original results
  }

  if (current.mode !== 'interactive') {
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
      const message = firstIssue?.description ?? 'Self-review found issues';
      // Persist self-review outputs (verdict, retryCount, maxRetries, issues) so
      // the failure step in the UI can render "MAX RETRIES" + the residual issues
      // instead of just "x". Without this stepPartialIO call the catch handler
      // writes failureOutputs without any self-review fields.
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
      throw new Error(
        `Self-review found ${issueCount || 'one or more'} issue(s)${retriesLabel} in ${location}: ${message}`,
      );
    }
  }

  return {
    inputs: { ...inputs, enabled: !result.skipped },
    outputs: { ...result, cliCommand },
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
    latestResolvedHumanGateDecision,
    reviewPlanFromSelection,
  } = context;
  const current = getRun(runId)!;
  const gateType = current.flowType === 'review-pr' ? 'review' : 'ready';
  const noChangeGate = shouldForceNoChangeHumanGate(current);
  const publicationApprovalGate = requiresPublicationApproval(current);
  const artifactOnly = isArtifactOnlyRun(current);
  if (isLightweightInteractiveDevRun(current)) {
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
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — human-gate skipped for artifact-only completion policy`,
    );
    return {
      inputs: { gateType, completionPolicy: current.completionPolicy },
      outputs: { skipped: true, reason: 'artifact-only-policy' },
    };
  }

  // Check if gate is disabled for this flow via project.json human_gates
  const configuredGateEnabled = await isHumanGateEnabled(
    current.project,
    current.flowType,
    current.mode,
  );
  const gateEnabled = noChangeGate || configuredGateEnabled;
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

  // Track wait duration
  const gateStart = Date.now();

  // Dispatch to flow-specific gate logic
  if (noChangeGate) {
    await executeNoChangeGate(runId);
  } else if (current.flowType === 'review-pr') {
    await executeReviewGate(runId);
  } else {
    if (publicationApprovalGate) {
      const initialPlan = getRun(runId)?.engineState?.publishGate?.pendingReviewPlan ?? [];
      if (initialPlan.length) {
        const dispatchReviewSlotId = current.slotId;
        if (!dispatchReviewSlotId)
          throw new Error('No slot assigned — cannot run dispatch publish-gate reviews');
        const dispatchPlan = initialPlan.slice(0, MAX_PUBLISH_GATE_REVIEW_LOOPS);
        const beforeDispatchReviews = getRun(runId)!;
        updateRun(runId, {
          engineState: {
            ...beforeDispatchReviews.engineState,
            publishGate: {
              ...beforeDispatchReviews.engineState?.publishGate,
              pendingReviewPlan: [],
            },
          },
        });
        await executePublishGateReviewPlan(runId, dispatchReviewSlotId, dispatchPlan, 'dispatch');
        const diffStat = await getDiffStat(getRun(runId)!);
        await prepareCompletionPackage(runId, {
          diffStat,
          reviewDepth: getRun(runId)?.engineState?.publishGate?.reviewDepth,
          publicationTarget: getRun(runId)?.engineState?.publishGate?.publicationTarget,
          requireArtifactMirror: true,
        });
      }
    }
    let gateAction = await executeReadyGate(runId);
    let reviewRequestLoops = 0;
    while (
      publicationApprovalGate &&
      !isPublishApprovalAction(gateAction) &&
      gateAction !== CLOSE_AS_SHIPPED_ACTION
    ) {
      if (gateAction === 'hold') {
        gateAction = await executeReadyGate(runId);
        continue;
      }
      if (gateAction === 'request-extra-review' || gateAction === 'request-cross-runner-review') {
        if (reviewRequestLoops >= MAX_HUMAN_GATE_REVIEW_REQUEST_LOOPS) {
          throw blockedRunError(
            `Publication gate review request limit reached (${MAX_HUMAN_GATE_REVIEW_REQUEST_LOOPS})`,
            gateAction,
          );
        }
        const beforeReviewPlan = getRun(runId)!;
        const latestGateDecision = latestResolvedHumanGateDecision(getRun(runId)!.decisions, true);
        const reviewedPackage = await readReadyGatePreparedPackage(beforeReviewPlan);
        const pendingPlan = beforeReviewPlan.engineState?.publishGate?.pendingReviewPlan ?? [];
        const plan = pendingPlan.length
          ? pendingPlan
          : reviewPlanFromSelection(latestGateDecision?.selectionData);
        const remainingBudget = Math.max(0, MAX_PUBLISH_GATE_REVIEW_LOOPS - reviewRequestLoops);
        const boundedPlan = plan.slice(0, remainingBudget);
        if (!boundedPlan.length) {
          gateAction = await executeReadyGate(runId);
          continue;
        }
        const reviewSlotId = current.slotId;
        if (!reviewSlotId)
          throw blockedRunError(
            'Publication gate requested extra review but no slot is assigned',
            gateAction,
          );
        reviewRequestLoops += boundedPlan.length;
        updateRun(runId, {
          engineState: {
            ...beforeReviewPlan.engineState,
            publishGate: {
              ...beforeReviewPlan.engineState?.publishGate,
              pendingReviewPlan: [],
            },
          },
        });
        const newReviewIds = await executePublishGateReviewPlan(
          runId,
          reviewSlotId,
          boundedPlan,
          'human-gate',
        );
        const diffStat = await getDiffStat(getRun(runId)!);
        const prepared = await prepareCompletionPackage(runId, {
          diffStat,
          reviewDepth: getRun(runId)?.engineState?.publishGate?.reviewDepth,
          publicationTarget: getRun(runId)?.engineState?.publishGate?.publicationTarget,
          selectedEvidenceKeys: reviewedPackage?.selectedEvidenceKeys,
          priorEvidenceManifest: reviewedPackage?.evidenceManifest,
          stampReviews: false,
          requireArtifactMirror: true,
        });
        stampFreshReviewsForPreparedPackage(runId, newReviewIds, prepared.prPackage);
        gateAction = await executeReadyGate(runId);
        continue;
      }
      throw blockedRunError(`Publication gate blocked by action: ${gateAction}`, gateAction);
    }
  }

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

export async function executeCompleteStep(
  runId: string,
  context: PostDispatchStepContext,
): Promise<StepIO> {
  const { broadcastFn, getDiffStat, refreshRunLinks } = context;
  const current = getRun(runId)!;
  if (!current.slotId) throw new Error('No slot assigned');
  const noCodeDisposition = isNoCodeTerminalDisposition(current.metrics.disposition);
  const artifactOnly = isArtifactOnlyRun(current);
  const inputs: Record<string, unknown> = {
    slotId: current.slotId,
    flowType: current.flowType,
    noCodeDisposition,
    artifactOnly,
  };
  await captureReviewInputArtifactsForRun(current);

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
        reviewDepth: prepared.reviewDepth,
        independentReviews: prepared.independentReviews,
        reviewSatisfied: independentReviewPolicySatisfied(
          prepared.reviewDepth,
          prepared.independentReviews,
        ),
      },
    };
  }
  const completion = await runCompletionPipeline(runId, {
    skipRetrospective,
    suppressPrMutation: noCodeDisposition || artifactOnly,
  });
  await refreshRunLinks(runId);
  if (completion.prNumber) {
    await captureReviewInputArtifactsForRun(getRun(runId) ?? current);
  }

  const runBeforeDiff = getRun(runId) ?? current;
  if (runBeforeDiff.engineState?.evalExperiment) {
    await executeEvalHarnessLifecycle(runBeforeDiff, 'cleanup');
    await refreshArtifactMirror(getRun(runId) ?? runBeforeDiff);
  }

  // diffStat needs the slot's git tree; runs before slotRelease below.
  const diffStat = await getDiffStat(getRun(runId) ?? current);
  const finalizedEvalPackage = await finalizeEvalResultPackageForRun(getRun(runId) ?? current);
  let slotDisposition: 'ci-watch' | 'released';

  if (!noCodeDisposition && hasCIWatch && completion.prNumber && completion.ciRepo) {
    // Keep slot alive for CI monitoring — worker is done so clear agent
    await markSlotHeld(current.slotId, 'ci-watch');
    console.log(`[run-engine] run ${runId.slice(0, 8)} — slot ${current.slotId} → ci-watch`);
    slotDisposition = 'ci-watch';
  } else {
    // No CI watch (review-pr) or no PR found — release slot
    const noopEmit = () => {};
    await slotRelease({ slotId: current.slotId, keepWork: true, detachRuns: false }, noopEmit);
    slotDisposition = 'released';
  }
  const cliCommand = `farmslot slot release ${current.slotId} --keep-warm`;
  return {
    inputs,
    outputs: {
      prNumber: completion.prNumber,
      ciRepo: completion.ciRepo,
      artifactsCopied: completion.artifactsCopied,
      prCommentPosted: completion.prCommentPosted,
      prTitleUpdated: completion.prTitleUpdated,
      prMarkedReady: completion.prMarkedReady,
      retrospectiveCreated: completion.retrospectiveCreated,
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
