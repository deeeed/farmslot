// review.ts — Automated review step (D7)
// Spawns a second runner session in a new tmux window on the same slot.
// The review agent has full codebase access — can read files, run tsc, execute recipe.
// Writes review-feedback.md; if issues found, feeds back to worker for a fix pass.
import path from 'node:path';

import {
  type AgentContext,
  isTerminalRunStatus,
  PipelineSteps,
  primaryRoleForFlow,
  type ReviewAttempt,
  type ReviewDiffSnapshot,
  type ReviewFixDeltaSnapshot,
  type ReviewIssue,
  type ReviewLoopTimelineSegment,
  type ReviewMode,
  type ReviewSessionTrace,
  type ReviewValidationDepth,
  type Run,
  type RunnerSessionUsage,
  type RunStatus,
  type WorkerSignal,
} from '@farmslot/protocol';
import { executionModelFromSelection, resolveReviewMode } from '@farmslot/review-dispatch';

import {
  markAgentContextStatus,
  resolveAgentTarget,
  selectAgentContext,
  upsertAgentContext,
} from '../agents/contexts.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { onSlotReset } from '../core/state.js';
import {
  resolveExactTmuxWindowPane,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { ensureNodeSupportBundle } from '../node-support/ensure.js';
import { prepareRetainedRunCapabilities } from '../run-engine/declared-capabilities.js';
import { runSupersededSince } from '../run-engine/run-generation.js';
import { buildLaunchCommand, RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../runners/launch-command.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { readLaunchAckSignalSnapshot } from '../runners/prompt-delivery-evidence.js';
import {
  normalizeRunner,
  runnerDefaultModel,
  runnerLineLooksWaiting,
  runnerNeedsPostLaunchPrompt,
  runnerRetainedSessionHandoff,
  runnerSupportsInteractivePrompt,
  runnerSupportsModel,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import { resolvePersistedRunnerSessionBinding } from '../runners/session-process.js';
import { deliverPromptToLiveRunner } from '../runners/session-reactivation.js';
import {
  captureAndRecordRunnerSession,
  clearedRunnerSessionContextPatch,
  recordRunnerSessionForRole,
} from '../runners/session-record.js';
import { getRunnerStatusProvider } from '../runners/status-provider.js';
import { resolveWorkerDispatchPrompt } from '../runners/worker-prompt.js';
import { clearRunActiveTaskFile, getRun, updateRun, updateRunStep } from '../runs/store.js';
import {
  checklistMarkerCommand,
  restoreWorkerChecklistTargetFromSlot,
  REVIEW_FIX_CHECKLIST_TARGET,
  slotTaskRelPath,
  syncChecklistTargetForRole,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext, watchContext } from '../tasks/watcher.js';
import {
  normalizeWorkerSignal,
  signalFreshSince,
  terminalWorkerSignalFromRaw,
} from '../tasks/worker-signals.js';

import { finishReviewCleanup } from './cleanup.js';
import { parseReviewIssueBullets } from './issues.js';
import { deliverNativeFix, nativeFixTurnIsActive, prepareNativeFix } from './native-fix.js';
import {
  assertNativeReviewOperationCurrent,
  captureNativeReviewOperationCheck,
  nativeReviewOperationIsCurrent,
  withNativeReviewMutation,
  withNativeReviewOperation,
} from './native-review-operation.js';
import { initReviewProgress, startProgressWatcher } from './progress.js';
import { type ReviewAgentResult, runReviewAgent } from './review-agent.js';
import { runReviewRoundBudget } from './review-round-budget.js';
import { recordReviewedInputs } from './reviewed-inputs.js';
import {
  invalidateWarmReviewerSessions,
  invalidateWarmReviewerSessionsForSlot,
  shouldRetainCompletedReviewer,
} from './session-mode.js';
import {
  captureCurrentHeadSha,
  captureFixDeltaSnapshot,
  debugReviewLog,
  durationBetween,
  readOptionalSlotFile,
  removeSlotFiles,
  reviewAttemptFromResult,
} from './snapshots.js';
import { expandReviewFixTemplate, getReviewConfig, resolveWorkerTaskDir } from './templates.js';
import {
  ensureTmuxTargetReadyForRelaunch,
  isWorkerAlive,
  paneHostsRunnerProcess,
  rediscoverAcceptingWorkerPane,
  runnerTurnLeaseIsActive,
  type WorkerPaneRediscovery,
} from './worker-lifecycle.js';
export { handleReviewFsChanged } from './progress.js';

export interface ReviewResult {
  reviewId?: string;
  mode?: ReviewMode;
  session?: ReviewSessionTrace;
  reviewerSessionId?: string | null;
  skipped?: boolean;
  reason?: string;
  verdict?: 'pass' | 'issues' | 'blocked';
  issues?: ReviewIssue[];
  reviewSnapshot?: ReviewDiffSnapshot;
  fixDelta?: ReviewFixDeltaSnapshot;
  attempts?: ReviewAttempt[];
  validationDepth?: ReviewValidationDepth;
  usage?: RunnerSessionUsage;
  taskProgressArtifactPath?: string;
  timeline?: ReviewLoopTimelineSegment[];
  runner?: string;
  model?: string;
  effort?: string | null;
  retryCount: number;
  maxRetries?: number;
  feedbackSent?: boolean;
  /** Reviewer findings are valid, but their worker fix handoff still needs recovery. */
  recoveryContinuationPending?: boolean;
  durationMs?: number;
}

/** The fix checklist exists, but the retained worker did not accept its prompt. */
export class ReviewFixDeliveryError extends Error {
  override name = 'ReviewFixDeliveryError';
}

function resolveWorkerModel(
  run: Pick<NonNullable<ReturnType<typeof getRun>>, 'metrics'> | null | undefined,
  runner: string,
  fallback: string,
): string {
  return run?.metrics.model?.trim() || runnerDefaultModel(runner) || fallback;
}

export interface ReviewOptions {
  reviewRunner?: string | null;
  model?: string | null;
  effort?: string | null;
  maxRetries?: number | null;
  validationDepth?: ReviewValidationDepth | null;
  artifactScope?: string | null;
  publicationReview?: boolean | null;
  mode?: ReviewMode | null;
  reviewId?: string | null;
  /** Completed generations of this same lineage, retained as provenance on recheck. */
  priorAttempts?: ReviewAttempt[];
  /** Continue an operator-approved fix loop from findings already produced by this run. */
  resumeFromResult?: ReviewResult;
  /** Send back: the first resumed fix pass is already charged by a persisted reservation. */
  reservedFixPass?: ReservedFixPass;
}

/** One pre-charged worker-fix pass; the loop consumes it without another increment. */
export interface ReservedFixPass {
  /** Called once the retained worker accepts the reserved fix turn. */
  onDelivered?: () => void;
}

const DEFAULT_REVIEW_TIMEOUT_MIN = 30;
const FEEDBACK_TIMEOUT_MS = 30 * 60_000; // 30 min without a fix-progress signal
const FEEDBACK_MAX_ACTIVE_MS = 2 * 60 * 60_000; // bound continuously progressing fix passes

type BroadcastFn = (event: string, payload: unknown) => void;

export function shouldSkipForDisabledReviewConfig(
  config: { enabled: boolean },
  options: Pick<ReviewOptions, 'publicationReview'> = {},
): boolean {
  return !config.enabled && options.publicationReview !== true;
}

/** Extra-review auto-fix budget. Restart/resume must not raise this past project max_retries. */
export function resolveReviewMaxRetries(opts: {
  publicationReview?: boolean | null;
  configuredMaxRetries?: number;
  requestedMaxRetries?: number | null;
  priorRetryCount?: number;
  resume?: boolean;
}): number {
  const projectCap = Math.max(0, opts.configuredMaxRetries ?? 1);
  const requested = opts.requestedMaxRetries;
  const hasRequested = typeof requested === 'number' && Number.isFinite(requested);
  const base = opts.publicationReview
    ? Math.max(0, hasRequested ? Math.min(projectCap, requested) : projectCap)
    : Math.max(0, Math.min(5, hasRequested ? requested : projectCap));
  if (!opts.resume || opts.publicationReview) return base;
  return Math.max((opts.priorRetryCount ?? 0) + 1, base);
}

export function resolveReviewRunnerModel(
  config: { runner?: string; model?: string },
  options: Pick<ReviewOptions, 'reviewRunner' | 'model'> = {},
): { reviewRunner: string; model: string } {
  const reviewRunner = normalizeRunner(
    options.reviewRunner?.trim() || config.runner?.trim() || 'codex',
  );
  // Project models belong to the explicitly configured runner. An unqualified
  // model must never leak into the default reviewer or an operator override.
  const configuredModel =
    config.runner?.trim() && normalizeRunner(config.runner) === reviewRunner
      ? config.model?.trim()
      : undefined;
  const model =
    options.model?.trim() || configuredModel || runnerDefaultModel(reviewRunner) || 'unknown';
  if (!runnerSupportsModel(reviewRunner, model))
    throw new Error(
      `Review runner '${reviewRunner}' does not support model '${model}'. Set review.runner and a compatible review.model, or select a compatible review override.`,
    );
  return { reviewRunner, model };
}

export function initReview(broadcast: BroadcastFn): void {
  initReviewProgress(broadcast);
  // Recycle cancels active claims. Completed reviewer transcripts are retained
  // for a verified continuation of this repository/PR lineage.
  onSlotReset((slotId) => {
    invalidateWarmReviewerSessionsForSlot(slotId);
  });
}

export async function executeReview(
  runId: string,
  slotId: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');
  const result = await withNativeReviewOperation(run, () =>
    executeOwnedReview(runId, slotId, options),
  );
  // Pipeline and publication reviews both end here: a pass is what was reviewed.
  if (result.verdict === 'pass' && !result.skipped) {
    await recordReviewedInputs(runId).catch((err: Error) =>
      console.warn(
        `[review] run ${runId.slice(0, 8)} — reviewed inputs not recorded: ${err.message}`,
      ),
    );
  }
  return result;
}

async function executeOwnedReview(
  runId: string,
  slotId: string,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  const config = await getReviewConfig(run.project);
  const requestedEffort = options.effort === undefined ? (config.effort ?? null) : options.effort;
  if (shouldSkipForDisabledReviewConfig(config, options)) {
    debugReviewLog(`[review] run ${runId.slice(0, 8)} — disabled for project ${run.project}`);
    return { skipped: true, reason: 'disabled-for-project', retryCount: 0 };
  }

  const vars = await loadSlotVars(slotId);
  const workerRunner = normalizeRunner(run.metrics.runner);
  const { reviewRunner, model } = resolveReviewRunnerModel(config, options);
  const maxRetries = resolveReviewMaxRetries({
    publicationReview: options.publicationReview,
    configuredMaxRetries: config.max_retries,
    requestedMaxRetries: options.maxRetries,
  });
  // Callers own the review contract: base review records its depth on the step,
  // publication reviews carry theirs on the plan. There is no implicit live default.
  const validationDepth = options.validationDepth ?? options.resumeFromResult?.validationDepth;
  if (!validationDepth)
    throw new Error(`Review for run ${runId} requires an explicit validation depth`);
  const artifactScope = options.artifactScope ?? null;
  const mode = resolveReviewMode({ explicitMode: options.mode, defaultMode: config.mode });
  const effort = executionModelFromSelection({
    runner: reviewRunner,
    model,
    effort: requestedEffort ?? null,
    mode,
  }).effort;
  const primaryContext = run.reviewContext ?? run.prWork?.review?.options.reviewContext;
  const reviewId =
    options.reviewId ??
    (mode === 'warm' ? primaryContext?.reviewLineages[0]?.reviewId : `pipeline-review-${run.id}`);
  const reviewTimeoutMs = (config.review_timeout_min ?? DEFAULT_REVIEW_TIMEOUT_MIN) * 60_000;
  const start = Date.now();
  let hasReusableReviewResult =
    options.resumeFromResult?.verdict === 'pass' || options.resumeFromResult?.verdict === 'issues';

  // Resolve task dir on the worker repo
  const taskDir = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
  if (!taskDir) {
    debugReviewLog(`[review] run ${runId.slice(0, 8)} — no task dir found`);
    return { skipped: true, reason: 'no-task-dir', retryCount: 0 };
  }

  try {
    const recoveredFixResult = await recoverReviewFixPass({
      vars,
      taskDir,
      slotId,
      runId,
      start,
      reviewRunner,
      model,
      effort: effort,
      workerRunner,
      maxRetries,
      reviewTimeoutMs,
      validationDepth,
      artifactScope,
      mode,
      findingsArtifactScope: artifactScope,
    });
    if (recoveredFixResult) {
      hasReusableReviewResult =
        recoveredFixResult.verdict === 'pass' || recoveredFixResult.verdict === 'issues';
      return {
        ...recoveredFixResult,
        usage: recoveredFixResult.attempts?.at(-1)?.usage,
        runner: reviewRunner,
        model,
        effort: effort,
      };
    }

    if (options.resumeFromResult) {
      if (
        options.resumeFromResult.verdict !== 'issues' ||
        !options.resumeFromResult.issues?.length
      ) {
        return {
          ...options.resumeFromResult,
          runner: reviewRunner,
          model,
          effort: effort,
        };
      }
      const priorAttempts = options.resumeFromResult.attempts ?? [];
      const priorRetryCount = options.resumeFromResult.retryCount;
      const previousAttempt = options.resumeFromResult.attempts?.at(-1);
      const initialReviewResult: ReviewAgentResult = {
        reviewId: options.resumeFromResult.reviewId ?? reviewId ?? undefined,
        mode: options.resumeFromResult.mode,
        session: options.resumeFromResult.session,
        reviewerSessionId: options.resumeFromResult.reviewerSessionId,
        verdict: 'issues',
        issues: options.resumeFromResult.issues ?? [],
        validationDepth: options.resumeFromResult.validationDepth,
        usage: options.resumeFromResult.usage,
        checklistTiming: previousAttempt?.checklistTiming,
        reviewSnapshot: options.resumeFromResult.reviewSnapshot,
        fixDelta: options.resumeFromResult.fixDelta,
        artifactPaths: previousAttempt?.artifactPaths,
        taskProgressArtifactPath: options.resumeFromResult.taskProgressArtifactPath,
        timeline: options.resumeFromResult.timeline,
        startedAt: previousAttempt?.startedAt,
        completedAt: previousAttempt?.completedAt,
      };
      const retryResult = await runReviewRetryLoop({
        vars,
        taskDir,
        slotId,
        runId,
        start,
        workerRunner,
        reviewRunner,
        model,
        effort: effort,
        // Pipeline review: Continue Fixing authorizes one more pass even
        // when project max_retries is 0. Extra-review stays on the project cap
        // so restart cannot keep raising priorRetryCount+1 forever.
        maxRetries: resolveReviewMaxRetries({
          publicationReview: options.publicationReview,
          configuredMaxRetries: config.max_retries,
          requestedMaxRetries: maxRetries,
          priorRetryCount,
          resume: true,
        }),
        reviewTimeoutMs,
        reviewResult: initialReviewResult,
        retryCount: priorRetryCount,
        priorAttempts,
        feedbackAlreadySent: options.resumeFromResult.feedbackSent,
        validationDepth,
        artifactScope,
        mode,
        ...(options.reservedFixPass ? { reservedFixPass: options.reservedFixPass } : {}),
      });
      return {
        ...retryResult,
        usage: retryResult.attempts?.at(-1)?.usage,
        runner: reviewRunner,
        model,
        effort: effort,
      };
    }

    // First review pass
    debugReviewLog(
      `[review] run ${runId.slice(0, 8)} — spawning review agent (${reviewRunner}/${model}, timeout ${reviewTimeoutMs / 60_000}min)`,
    );
    const priorAttempts = options.priorAttempts ?? [];
    const firstLoopNumber = (priorAttempts.at(-1)?.loopNumber ?? 0) + 1;
    const result = await runReviewAgent(
      vars,
      reviewRunner,
      model,
      taskDir,
      slotId,
      runId,
      reviewTimeoutMs,
      firstLoopNumber,
      validationDepth,
      artifactScope,
      mode,
      effort,
      reviewId,
    );

    if (result.incomplete) {
      console.warn(
        `[review] run ${runId.slice(0, 8)} — INCOMPLETE: agent exited without writing feedback`,
      );
      const attempts = [...priorAttempts, reviewAttemptFromResult(result, firstLoopNumber)];
      return {
        skipped: true,
        reason: 'no-feedback-file',
        runner: reviewRunner,
        model,
        effort: effort,
        retryCount: 0,
        validationDepth,
        usage: result.usage,
        mode: result.mode,
        reviewId: result.reviewId,
        session: result.session,
        reviewerSessionId: result.reviewerSessionId,
        reviewSnapshot: result.reviewSnapshot,
        attempts,
        timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
        durationMs: Date.now() - start,
      };
    }

    // A pass or issues verdict is a valid review generation. Keep that
    // reviewer claim for an explicit continuation even if worker-fix delivery
    // later fails; launch/timeout/invalid-artifact failures never set this.
    hasReusableReviewResult = true;

    if (result.verdict === 'pass') {
      debugReviewLog(`[review] run ${runId.slice(0, 8)} — PASS (${Date.now() - start}ms)`);
      return {
        verdict: 'pass',
        issues: [],
        validationDepth,
        usage: result.usage,
        mode: result.mode,
        reviewId: result.reviewId,
        session: result.session,
        reviewerSessionId: result.reviewerSessionId,
        reviewSnapshot: result.reviewSnapshot,
        attempts: [...priorAttempts, reviewAttemptFromResult(result, firstLoopNumber)],
        timeline: result.timeline,
        runner: reviewRunner,
        model,
        effort: effort,
        retryCount: 0,
        durationMs: Date.now() - start,
      };
    }

    const retryResult = await runReviewRetryLoop({
      vars,
      taskDir,
      slotId,
      runId,
      start,
      workerRunner,
      reviewRunner,
      model,
      effort: effort,
      maxRetries,
      reviewTimeoutMs,
      reviewResult: result,
      priorAttempts: [...priorAttempts, reviewAttemptFromResult(result, firstLoopNumber)],
      retryCount: 0,
      validationDepth,
      artifactScope,
      mode,
    });
    return {
      ...retryResult,
      usage: retryResult.attempts?.at(-1)?.usage,
      runner: reviewRunner,
      model,
      effort: effort,
    };
  } finally {
    // Completed reviewer sessions can be explicitly continued from the human gate, but
    // only after a valid review generation. A failed launch, timeout, or invalid
    // terminal artifact must not leave a claimable reviewer session behind.
    if (!shouldRetainCompletedReviewer(hasReusableReviewResult)) {
      invalidateWarmReviewerSessions(runId, reviewRunner);
    }
  }
}

interface FixDeliveryAcceptance {
  signalBaseline: string;
  turnToken?: string;
}

type FixPromptDeliveryResult =
  | { status: 'delivered'; turnToken?: string }
  | { status: 'deferred' | 'relaunch-required' | 'unsupported' | 'blocked' };

// Dep surface for runReviewRetryLoop. Real production wiring lives in
// defaultReviewRetryDeps below; tests pass a struct of mocks to exercise the
// retry boundary without standing up tmux/worker infrastructure.
export interface ReviewRetryDeps {
  isWorkerAlive: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    runId?: string,
  ) => Promise<boolean>;
  relaunchWorkerForFix: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    model: string,
    runId: string,
  ) => Promise<boolean>;
  resumeFixPromptDelivery: typeof resumeReviewFixPromptDelivery;
  sendFeedbackToWorker: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    issues: ReviewIssue[],
    taskDir: string,
    runId: string,
    fixBaseSha: string | null,
    findingsArtifactScope?: string | null,
  ) => Promise<FixDeliveryAcceptance>;
  startProgressWatcher: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    filePath: string,
    runId: string,
    label?: string,
  ) => { stop(): void | Promise<void> };
  waitForWorkerSignal: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
    timeoutMs: number,
    baseline: string,
    turnActive?: () => Promise<boolean>,
  ) => Promise<WorkerSignal | undefined>;
  // Loop never reads the return values — narrow to Promise<void> so test mocks don't have to
  // synthesize the production AgentContext shape just to satisfy the type checker.
  markAgentContextStatus: (...args: Parameters<typeof markAgentContextStatus>) => Promise<void>;
  unwatchContext: (slotId: string, role: 'review-fix') => Promise<void>;
  runReviewAgent: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    model: string,
    taskDir: string,
    slotId: string,
    runId: string,
    reviewTimeoutMs: number,
    loopNumber: number,
    validationDepth: ReviewValidationDepth,
    artifactScope?: string | null,
    mode?: ReviewMode,

    effort?: string | null,
    reviewId?: string | null,
  ) => Promise<ReviewAgentResult>;
  captureFixDelta: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
    loopNumber: number,
    fixBaseSha: string | null,
    artifactScope?: string | null,
  ) => Promise<{ snapshot: ReviewFixDeltaSnapshot; artifactPaths: string[] }>;
  captureHeadSha: (vars: Awaited<ReturnType<typeof loadSlotVars>>) => Promise<string | null>;
  /** Optional: worker context-window usage (%) read before each fix delivery. */
  getWorkerContextPct?: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    runId: string,
  ) => Promise<number | null>;
  restoreWorkerChecklistTargetFromSlot: (
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    taskDir: string,
    terminal?: { flowType: string; mode?: string | null },
  ) => Promise<void>;
  setProgressDetail?: (runId: string, detail: string) => void;
  setRunStatus?: (runId: string, status: RunStatus) => void;
  fixTurnIsActive?: typeof reviewFixTurnIsActive;
  getRun: typeof getRun;
}

function setReviewProgressDetail(runId: string, detail: string): void {
  const run = getRun(runId);
  if (!run) return;
  const step = run.steps.find(
    (candidate) => candidate.name === PipelineSteps.HUMAN_GATE && candidate.status === 'running',
  )
    ? PipelineSteps.HUMAN_GATE
    : PipelineSteps.REVIEW;
  updateRunStep(runId, step, { detail });
}

export async function reviewFixTurnIsActive(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId: string,
  workerRunner: string,
  expectedTurnToken: string,
): Promise<boolean> {
  const run = getRun(runId);
  const fixContext = run ? selectAgentContext(run, { role: 'review-fix' }) : null;
  if (run?.transport === 'native') return nativeFixTurnIsActive(runId, expectedTurnToken);
  if (fixContext?.status !== 'working') return false;
  const target = fixContext?.target?.target;
  if (!target) return false;
  const runner = fixContext.runner ?? workerRunner;
  return runnerTurnLeaseIsActive(vars, target, runner, expectedTurnToken);
}

// Module-level constant — wiring is fixed at module load. Tests pass their own deps struct
// instead of reassigning here. Function declarations referenced inside the literal are
// hoisted, so the const initializer captures live function refs even though they appear
// later in the file.
const PRODUCTION_DEPS: ReviewRetryDeps = {
  isWorkerAlive,
  relaunchWorkerForFix,
  resumeFixPromptDelivery: resumeReviewFixPromptDelivery,
  sendFeedbackToWorker,
  startProgressWatcher: (vars, file, runId, label) =>
    startProgressWatcher(vars, file, runId, label, {
      isCurrent: captureNativeReviewOperationCheck(),
    }),
  waitForWorkerSignal,
  markAgentContextStatus: (...args) =>
    withNativeReviewMutation(() => markAgentContextStatus(...args)),
  unwatchContext: (...args) => withNativeReviewMutation(() => unwatchContext(...args)),
  runReviewAgent,
  captureFixDelta: (...args) => withNativeReviewMutation(() => captureFixDeltaSnapshot(...args)),
  captureHeadSha: captureCurrentHeadSha,
  getWorkerContextPct: readWorkerContextPct,
  restoreWorkerChecklistTargetFromSlot,
  setProgressDetail: setReviewProgressDetail,
  setRunStatus: (runId, status) => {
    updateRun(runId, { status });
  },
  fixTurnIsActive: reviewFixTurnIsActive,
  getRun,
};

export function resolveRecoveredFixBaseSha(
  run: Pick<Run, 'engineState'> | null | undefined,
  context: Pick<AgentContext, 'artifactScope' | 'deliveryBaselineRef'>,
  findingsArtifactScope?: string | null,
): string | null {
  const persisted = context.deliveryBaselineRef?.trim();
  if (persisted) return persisted;

  const artifactScope = context.artifactScope?.trim() || findingsArtifactScope?.trim();
  if (!artifactScope) return null;
  const owner = run?.engineState?.publishGate?.reviews?.find(
    (review) => review.id === artifactScope,
  );
  return owner?.reviewSnapshot?.headSha?.trim() || owner?.reviewedHeadSha?.trim() || null;
}

/**
 * True only when the delta capture SUCCEEDED and found nothing. An
 * `unavailable` snapshot (missing fix base, git failure, oversized diff, slot
 * exec error) means "unknown", not "empty" — a blocked worker whose delta could
 * not be read may still have changed files, so it must go through the re-review
 * rather than short-circuit as if it had touched nothing.
 */
function fixDeltaIsKnownEmpty(snapshot: ReviewFixDeltaSnapshot): boolean {
  if (snapshot.source !== 'local-git' || !snapshot.diffStat) return false;
  return snapshot.diffStat.files === 0 && (snapshot.untrackedFiles?.length ?? 0) === 0;
}

/**
 * A worker that blocked mid-fix leaves an external blocker on the run even when
 * the re-review of its partial changes passes. `buildPublishGateReviewStatus`
 * and `materializeReviewArtifacts` both derive the published review
 * verdict from the FINAL attempt, so leaving a `pass` attempt here would let the
 * publication gate materialize a qualifying PASS while the run is blocked.
 * Stamp the block onto that attempt so the aggregate verdict stays authoritative.
 */
function blockedReviewAttempt(attempt: ReviewAttempt, reason: string): ReviewAttempt {
  return { ...attempt, verdict: 'failed', reason };
}

export async function runReviewRetryLoop({
  vars,
  taskDir,
  slotId,
  runId,
  start,
  workerRunner,
  reviewRunner,
  model,
  effort,
  maxRetries,
  reviewTimeoutMs,
  reviewResult,
  retryCount,
  validationDepth,
  artifactScope = null,
  mode = resolveReviewMode(),
  feedbackAlreadySent = false,
  priorAttempts = [],
  reservedFixPass,
  deps = PRODUCTION_DEPS,
}: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  slotId: string;
  runId: string;
  start: number;
  workerRunner: string;
  reviewRunner: string;
  model: string;
  effort?: string | null;
  maxRetries: number;
  reviewTimeoutMs: number;
  reviewResult: ReviewAgentResult;
  retryCount: number;
  validationDepth: ReviewValidationDepth;
  artifactScope?: string | null;
  mode?: ReviewMode;
  feedbackAlreadySent?: boolean;
  priorAttempts?: ReviewAttempt[];
  reservedFixPass?: ReservedFixPass;
  deps?: ReviewRetryDeps;
}): Promise<ReviewResult> {
  const reviewGeneration = deps.getRun(runId)?.engineState?.generation ?? 0;
  let result = reviewResult;
  let feedbackSent = feedbackAlreadySent;
  const attempts: ReviewAttempt[] =
    priorAttempts.length > 0
      ? [...priorAttempts]
      : [reviewAttemptFromResult(result, retryCount + 1)];

  let roundLimitReason: string | undefined;
  let reserved = reservedFixPass;
  while (
    result.verdict === 'issues' &&
    result.issues.length > 0 &&
    (reserved !== undefined || retryCount < maxRetries)
  ) {
    assertNativeReviewOperationCurrent();
    const budgetRun = getRun(runId);
    const budget = budgetRun ? await runReviewRoundBudget(budgetRun) : undefined;
    if (budget?.remaining === 0) {
      roundLimitReason = budget.diagnosis;
      break;
    }
    console.log(
      `[review] run ${runId.slice(0, 8)} — ${result.issues.length} issue(s) found (retry ${retryCount + 1}/${maxRetries})`,
    );
    let workerAlive = await deps.isWorkerAlive(vars, workerRunner, runId);
    if (!workerAlive) {
      console.log(`[review] run ${runId.slice(0, 8)} — worker exited, re-launching primary worker`);
      const run = deps.getRun(runId);
      workerAlive = await deps.relaunchWorkerForFix(
        vars,
        workerRunner,
        run?.metrics.model ?? model,
        runId,
      );
      if (!workerAlive) {
        console.warn(
          `[review] run ${runId.slice(0, 8)} — failed to re-launch worker, skipping feedback`,
        );
        return {
          verdict: 'issues',
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          mode: result.mode,
          reviewId: result.reviewId,
          session: result.session,
          reviewerSessionId: result.reviewerSessionId,
          reviewSnapshot: result.reviewSnapshot,
          attempts,
          retryCount,
          maxRetries,
          // These findings never reached a worker. A `feedbackSent` carried over
          // from an earlier generation would make recovery skip continuation.
          feedbackSent: false,
          recoveryContinuationPending: true,
          durationMs: Date.now() - start,
        };
      }
    }

    // A context-saturated session silently swallows delivered prompts:
    // relaunch a fresh worker before spending a fix pass on it.
    const ctxPct = (await deps.getWorkerContextPct?.(vars, workerRunner, runId)) ?? null;
    if (ctxPct != null && ctxPct >= REVIEW_FIX_RELAUNCH_CTX_PCT) {
      console.log(
        `[review] run ${runId.slice(0, 8)} — worker context at ${ctxPct}% (≥${REVIEW_FIX_RELAUNCH_CTX_PCT}%), relaunching fresh worker before fix delivery`,
      );
      const run = deps.getRun(runId);
      const relaunched = await deps.relaunchWorkerForFix(
        vars,
        workerRunner,
        run?.metrics.model ?? model,
        runId,
      );
      if (!relaunched) {
        console.warn(
          `[review] run ${runId.slice(0, 8)} — failed to re-launch high-context worker, skipping feedback`,
        );
        return {
          verdict: 'issues',
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          mode: result.mode,
          reviewId: result.reviewId,
          session: result.session,
          reviewerSessionId: result.reviewerSessionId,
          reviewSnapshot: result.reviewSnapshot,
          attempts,
          retryCount,
          maxRetries,
          // Same as the dead-worker relaunch above: this generation's findings
          // were never delivered, so continuation must not be suppressed.
          feedbackSent: false,
          recoveryContinuationPending: true,
          durationMs: Date.now() - start,
        };
      }
    }

    // Send feedback to the primary worker. Each pass clears the previous fix
    // signal and waits on a fresh baseline, so every retry gets its own timeout.
    let fixBaseSha: string | null = null;
    try {
      fixBaseSha = await deps.captureHeadSha(vars);
    } catch (err) {
      debugReviewLog(
        `[review] run ${runId.slice(0, 8)} — failed to capture fix base SHA: ${(err as Error).message}`,
      );
    }
    let fixSignalBaseline: string | undefined;
    let fixTurnToken: string | undefined;
    let fixDeliveryDeferred = false;
    try {
      const delivery = await deps.sendFeedbackToWorker(
        vars,
        result.issues,
        taskDir,
        runId,
        fixBaseSha,
        artifactScope,
      );
      fixSignalBaseline = delivery.signalBaseline;
      fixTurnToken = delivery.turnToken;
    } catch (error) {
      if (!(error instanceof ReviewFixDeliveryError)) throw error;
      let deliveryError: unknown = error;
      console.warn(
        `[review] run ${runId.slice(0, 8)} — retained worker rejected the fix task; relaunching once before preserving the findings`,
      );
      const run = deps.getRun(runId);
      const fixContext = run?.agentContexts?.find(
        (context) => context.role === 'review-fix' && context.taskFile,
      );
      const relaunched = await deps.relaunchWorkerForFix(
        vars,
        workerRunner,
        resolveWorkerModel(run, workerRunner, model),
        runId,
      );
      if (relaunched) {
        const relaunchedFixContext =
          deps
            .getRun(runId)
            ?.agentContexts?.find((context) => context.role === 'review-fix' && context.taskFile) ??
          fixContext;
        if (relaunchedFixContext) {
          const delivery = await deps.resumeFixPromptDelivery(
            vars,
            runId,
            relaunchedFixContext,
            undefined,
            { priorPromptSendAttempted: false },
          );
          if (delivery.status === 'delivered' || delivery.status === 'deferred') {
            // Deferred acknowledgement is uncertain: the fresh worker may already
            // be fixing. Keep observing its signal instead of failing the run.
            fixSignalBaseline = '';
            fixDeliveryDeferred = delivery.status === 'deferred';
            fixTurnToken = delivery.status === 'delivered' ? delivery.turnToken : undefined;
          } else deliveryError = new Error(`fresh-worker fix delivery ${delivery.status}`);
        }
      }
      if (fixSignalBaseline === undefined) {
        const message =
          deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
        console.warn(
          `[review] run ${runId.slice(0, 8)} — preserving ${result.issues.length} reviewer finding(s) after fix delivery failed: ${message}`,
        );
        return {
          verdict: 'issues',
          reason: `fix-delivery-unavailable: ${message}`,
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          mode: result.mode,
          reviewId: result.reviewId,
          session: result.session,
          reviewerSessionId: result.reviewerSessionId,
          reviewSnapshot: result.reviewSnapshot,
          attempts,
          retryCount,
          maxRetries,
          feedbackSent: false,
          recoveryContinuationPending: true,
          durationMs: Date.now() - start,
        };
      }
    }
    const fixStartedAt = new Date().toISOString();
    // A reserved pass was charged before delivery; any later pass spends the budget here.
    if (reserved) {
      // Deferred acknowledgement is uncertain; recovery keeps the same charge and turn.
      if (!fixDeliveryDeferred) reserved.onDelivered?.();
      reserved = undefined;
    } else retryCount += 1;
    feedbackSent = true;
    // A pane reaction or signal baseline cannot establish fix acceptance.
    // Only this delivery's exact structured turn may report fixing.
    const statusGeneration = reviewGeneration;
    const fixActive = Boolean(
      fixTurnToken &&
      (await (deps.fixTurnIsActive ?? reviewFixTurnIsActive)(
        vars,
        runId,
        workerRunner,
        fixTurnToken,
      )),
    );
    if (deps.setRunStatus) {
      if (runSupersededSince(deps.getRun(runId), statusGeneration))
        throw new Error('Review fix was superseded before its state update');
      deps.setRunStatus(runId, fixActive ? 'fixing' : 'reconciling');
    }
    const nextLoopNumber = (attempts.at(-1)?.loopNumber ?? retryCount) + 1;
    deps.setProgressDetail?.(
      runId,
      fixDeliveryDeferred
        ? `Reviewer found ${result.issues.length} issue(s); fix delivery unconfirmed, watching REVIEW-FIX-SIGNAL...`
        : `Reviewer found ${result.issues.length} issue(s); worker applying fixes (${retryCount}/${maxRetries})...`,
    );
    console.log(
      `[review] run ${runId.slice(0, 8)} — ${fixDeliveryDeferred ? 'fix delivery deferred' : 'feedback sent to worker'}, waiting for fix signal`,
    );

    // Watch the fix task for progress
    const fixTaskPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
    const fixWatcher = deps.startProgressWatcher(vars, fixTaskPath, runId, 'Fix');
    let fixSignal;
    let fixCompletedAt = fixStartedAt;
    let workerBlockReason: string | null = null;
    let fixFailure: unknown;
    try {
      fixSignal = await deps.waitForWorkerSignal(
        vars,
        taskDir,
        FEEDBACK_TIMEOUT_MS,
        fixSignalBaseline,
        fixTurnToken
          ? () => reviewFixTurnIsActive(vars, runId, workerRunner, fixTurnToken)
          : undefined,
      );
      fixCompletedAt = new Date().toISOString();
      assertNativeReviewOperationCurrent();
      if (!fixSignal) {
        console.warn(`[review] run ${runId.slice(0, 8)} — timeout waiting for worker fix`);
        await deps.markAgentContextStatus(runId, 'review-fix', 'failed');
        await deps.unwatchContext(slotId, 'review-fix');
        if (retryCount >= maxRetries) {
          return {
            verdict: 'issues',
            issues: result.issues,
            validationDepth,
            usage: result.usage,
            mode: result.mode,
            reviewId: result.reviewId,
            session: result.session,
            reviewerSessionId: result.reviewerSessionId,
            reviewSnapshot: result.reviewSnapshot,
            attempts,
            retryCount,
            maxRetries,
            feedbackSent,
            durationMs: Date.now() - start,
          };
        }
        continue;
      }
      workerBlockReason =
        fixSignal.status === 'blocked'
          ? (fixSignal.reason ?? 'worker blocked during review fix')
          : null;
      if (workerBlockReason) {
        debugReviewLog(
          `[review] run ${runId.slice(0, 8)} — worker blocked during review fix: ${workerBlockReason}`,
        );
      }
      await deps.markAgentContextStatus(
        runId,
        'review-fix',
        fixSignal.status === 'blocked'
          ? 'blocked'
          : fixSignal.status === 'failed'
            ? 'failed'
            : 'complete',
        { lastSignalAt: new Date().toISOString() },
      );
      await deps.unwatchContext(slotId, 'review-fix');
      const fixDelta = await deps.captureFixDelta(
        vars,
        taskDir,
        nextLoopNumber,
        fixBaseSha,
        artifactScope,
      );
      if (workerBlockReason && fixDeltaIsKnownEmpty(fixDelta.snapshot)) {
        attempts.push({
          mode,
          loopNumber: nextLoopNumber,
          verdict: 'failed',
          unresolvedCount: result.issues.length,
          issues: result.issues,
          validationDepth,
          fixDelta: fixDelta.snapshot,
          artifactPaths: fixDelta.artifactPaths,
          completedAt: fixCompletedAt,
        });
        return {
          verdict: 'blocked',
          reason: workerBlockReason,
          issues: result.issues,
          validationDepth,
          usage: result.usage,
          mode: result.mode,
          reviewId: result.reviewId,
          session: result.session,
          reviewerSessionId: result.reviewerSessionId,
          reviewSnapshot: result.reviewSnapshot,
          fixDelta: fixDelta.snapshot,
          attempts,
          retryCount,
          maxRetries,
          feedbackSent,
          durationMs: Date.now() - start,
        };
      }
      const fixSegment: ReviewLoopTimelineSegment = {
        kind: 'worker-fix',
        loopNumber: nextLoopNumber,
        runner: workerRunner,
        model,
        startedAt: fixStartedAt,
        completedAt: fixCompletedAt,
        durationMs: durationBetween(fixStartedAt, fixCompletedAt),
        verdict: Boolean(workerBlockReason) || fixSignal.status === 'failed' ? 'failed' : 'pass',
        unresolvedCount: workerBlockReason ? result.issues.length : 0,
        artifactPaths: fixDelta.artifactPaths,
      };
      const priorResult = result;
      debugReviewLog(`[review] run ${runId.slice(0, 8)} — re-reviewing after worker fix`);
      if (deps.setRunStatus) {
        if (runSupersededSince(deps.getRun(runId), reviewGeneration))
          throw new Error('Review fix was superseded before re-review');
        deps.setRunStatus(runId, 'reviewing');
      }
      deps.setProgressDetail?.(
        runId,
        `${workerBlockReason ? 'Worker made partial fixes before blocking' : 'Worker fix complete'}; running ${reviewRunner} re-review (${nextLoopNumber})...`,
      );
      result = await deps.runReviewAgent(
        vars,
        reviewRunner,
        model,
        taskDir,
        slotId,
        runId,
        reviewTimeoutMs,
        nextLoopNumber,
        validationDepth,
        artifactScope,
        mode,
        effort,
        result.reviewId,
      );
      const retryAttempt: ReviewAttempt = {
        ...reviewAttemptFromResult(
          result,
          nextLoopNumber,
          fixDelta.snapshot,
          fixDelta.artifactPaths,
        ),
        timeline: [fixSegment, ...(result.timeline ?? [])],
      };
      attempts.push(
        workerBlockReason ? blockedReviewAttempt(retryAttempt, workerBlockReason) : retryAttempt,
      );
      debugReviewLog(`[review] run ${runId.slice(0, 8)} — retry verdict: ${result.verdict}`);
      if (workerBlockReason) {
        const reviewed = result.incomplete ? priorResult : result;
        const pending =
          !result.incomplete && result.verdict === 'issues' && result.issues.length > 0;
        return {
          verdict: 'blocked',
          reason: workerBlockReason,
          issues: reviewed.issues,
          validationDepth,
          usage: reviewed.usage,
          reviewId: reviewed.reviewId,
          mode: reviewed.mode,
          session: reviewed.session,
          reviewerSessionId: reviewed.reviewerSessionId,
          reviewSnapshot: reviewed.reviewSnapshot,
          fixDelta: fixDelta.snapshot,
          attempts,
          timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
          retryCount,
          maxRetries,
          feedbackSent: !pending,
          recoveryContinuationPending: pending,
          durationMs: Date.now() - start,
        };
      }
    } catch (error) {
      fixFailure = error;
      throw error;
    } finally {
      const parentRun = deps.getRun(runId);
      await finishReviewCleanup(fixFailure, [
        () => fixWatcher.stop(),
        async () => {
          if (!nativeReviewOperationIsCurrent()) return;
          await withNativeReviewMutation(() =>
            deps.restoreWorkerChecklistTargetFromSlot(
              vars,
              taskDir,
              parentRun
                ? { flowType: parentRun.flowType, mode: parentRun.mode ?? undefined }
                : undefined,
            ),
          );
        },
      ]);
    }
  }

  if (result.incomplete) {
    // A re-review after a fix pass exited without writing feedback. Its verdict
    // is a placeholder 'pass' from readReviewFeedback — returning it would
    // silently clear the previous reviewer's unresolved issues. Surface as
    // skipped (like the initial-review incomplete path) so the gate re-presents.
    console.warn(
      `[review] run ${runId.slice(0, 8)} — INCOMPLETE: re-review exited without writing feedback`,
    );
    return {
      skipped: true,
      reason: 'no-feedback-file',
      retryCount,
      maxRetries,
      feedbackSent,
      validationDepth,
      usage: result.usage,
      mode: result.mode,
      reviewId: result.reviewId,
      session: result.session,
      reviewerSessionId: result.reviewerSessionId,
      reviewSnapshot: result.reviewSnapshot,
      attempts,
      timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
      durationMs: Date.now() - start,
    };
  }

  // Reaching this return with unresolved issues means the latest review
  // generation has not been handed to the worker. `feedbackSent` may still be
  // true from an earlier generation, but persisting that historical value
  // makes recovery believe there is nothing left to deliver.
  const latestFindingsPendingDelivery = result.verdict === 'issues' && result.issues.length > 0;
  const retriesExhausted =
    Boolean(roundLimitReason) || (maxRetries > 0 && retryCount >= maxRetries);
  return {
    verdict: result.verdict,
    issues: result.issues,
    validationDepth,
    usage: result.usage,
    reviewId: result.reviewId,
    mode: result.mode,
    session: result.session,
    reviewerSessionId: result.reviewerSessionId,
    reviewSnapshot: result.reviewSnapshot,
    fixDelta: attempts.at(-1)?.fixDelta,
    attempts,
    timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
    retryCount,
    maxRetries,
    feedbackSent: latestFindingsPendingDelivery ? false : feedbackSent,
    recoveryContinuationPending: latestFindingsPendingDelivery && !retriesExhausted,
    ...(roundLimitReason ? { reason: roundLimitReason, maxRetriesExhausted: true } : {}),
    durationMs: Date.now() - start,
  };
}

// ─── Review Agent ───

async function readReviewFixIssues(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
): Promise<ReviewIssue[] | null> {
  const checklistPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
  const result = await execOnSlot(
    vars,
    `if [ -f ${shellQuote(checklistPath)} ]; then cat ${shellQuote(checklistPath)}; else exit 44; fi`,
  );
  if (result.exitCode === 44) return null;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read review fix findings: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  const content = result.stdout.trim();
  return parseReviewIssueBullets(content);
}

async function readOptionalReviewFixSignal(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  signalPath: string,
): Promise<string | null> {
  const result = await execOnSlot(
    vars,
    `if [ -f ${shellQuote(signalPath)} ]; then cat ${shellQuote(signalPath)}; else exit 44; fi`,
  );
  if (result.exitCode === 44) return null;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read review fix signal: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.trim();
}

export function canRecoverReviewFixPass(
  fixContext:
    | Pick<AgentContext, 'role' | 'status' | 'taskFile' | 'signalFile' | 'artifactScope'>
    | null
    | undefined,
  taskDir: string,
  findingsArtifactScope?: string | null,
): boolean {
  const matchesFindingsGeneration =
    !findingsArtifactScope ||
    !fixContext?.artifactScope ||
    fixContext.artifactScope === findingsArtifactScope;
  return (
    fixContext?.role === 'review-fix' &&
    fixContext.status === 'working' &&
    fixContext.taskFile === taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist) &&
    fixContext.signalFile === taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal) &&
    matchesFindingsGeneration
  );
}

type FixPromptRecoveryContext = Pick<
  AgentContext,
  | 'id'
  | 'runner'
  | 'model'
  | 'taskFile'
  | 'signalFile'
  | 'target'
  | 'attemptStartedAt'
  | 'promptDeliveryStartedAt'
  | 'startedAt'
>;

interface FixPromptRecoveryDeps {
  getRun: typeof getRun;
  prepareCapabilities?: (runId: string) => Promise<void>;
  resolvePrompt: typeof resolveWorkerDispatchPrompt;
  resolveRuntimeDir: typeof resolveProjectRuntimeDir;
  readLaunchAck: typeof readLaunchAckSignalSnapshot;
  syncChecklistTarget: typeof syncChecklistTargetForRole;
  ensureTarget: typeof ensureTmuxTargetReadyForRelaunch;
  targetHostsRunner?: typeof paneHostsRunnerProcess;
  persistTarget: (
    runId: string,
    run: Pick<NonNullable<ReturnType<typeof getRun>>, 'flowType' | 'agentContexts'>,
    target: AgentContext['target'],
  ) => Promise<void>;
  deliver: typeof deliverPromptToLiveRunner;
  recordDeliveryBoundary?: (
    runId: string,
    context: FixPromptRecoveryContext,
    startedAt: string,
    generation: number,
  ) => Promise<void>;
  rememberAcceptedTurn?: typeof rememberReviewFixTurn;
}

const FIX_PROMPT_RECOVERY_DEPS: FixPromptRecoveryDeps = {
  getRun,
  prepareCapabilities: prepareRetainedRunCapabilities,
  resolvePrompt: resolveWorkerDispatchPrompt,
  resolveRuntimeDir: resolveProjectRuntimeDir,
  readLaunchAck: readLaunchAckSignalSnapshot,
  syncChecklistTarget: syncChecklistTargetForRole,
  ensureTarget: ensureTmuxTargetReadyForRelaunch,
  targetHostsRunner: paneHostsRunnerProcess,
  persistTarget: async (runId, run, target) => {
    await upsertAgentContext(runId, 'review-fix', { target });
    const workerRole = primaryRoleForFlow(run.flowType);
    if (run.agentContexts?.some((candidate) => candidate.role === workerRole)) {
      await upsertAgentContext(runId, workerRole, { target });
    }
  },
  deliver: deliverPromptToLiveRunner,
  recordDeliveryBoundary: async (runId, expected, startedAt, generation) => {
    const context = await upsertAgentContext(
      runId,
      'review-fix',
      { id: expected.id },
      {
        guard: async () => !runSupersededSince(getRun(runId), generation),
        resolvePatch: (current) =>
          current &&
          current.attemptStartedAt === expected.attemptStartedAt &&
          current.taskFile === expected.taskFile &&
          current.signalFile === expected.signalFile
            ? { promptDeliveryStartedAt: startedAt, promptAcceptance: undefined }
            : null,
        mirrorIf: (slot) => slot.current_run_id === runId,
      },
    );
    if (!context) throw new Error('Review fix attempt changed before delivery');
  },
  rememberAcceptedTurn: rememberReviewFixTurn,
};

function reviewFixProgressContract(taskDir: string, taskFile: string): string {
  const mark = checklistMarkerCommand(taskDir, REVIEW_FIX_CHECKLIST_TARGET);
  return (
    `Follow ${taskFile} top-to-bottom. After EVERY checklist step run ${mark} N ` +
    `(bootstrap with ${mark} start). ` +
    `Skipping ${mark} leaves the fix timeout blind to real progress. ` +
    `On success finish with ${mark} complete --mark-last; when applicable use ` +
    `${mark} no-change --reason \"…\" or ${mark} blocked --reason \"…\" instead.`
  );
}

// Gateway delivery boundaries and slot receipt clocks can disagree; fix rounds are minutes apart.
const LEGACY_FIX_RECEIPT_CLOCK_TOLERANCE_MS = 60_000;

// The delivery identity leads the prompt: a runner's prompt receipt digests only its start, so
// every fix of the same REVIEW-FIX.md would otherwise share one receipt across rounds.
function reviewFixPrompt(basePrompt: string, taskDir: string, taskFile: string, delivery: string) {
  return `Farmslot fix delivery ${delivery}.\n\n${basePrompt}\n\n${reviewFixProgressContract(taskDir, taskFile)}`;
}

/**
 * Re-submit an already-materialized fix task after restart without rewriting the
 * task or clearing its signal. The retained-session delivery layer owns runner
 * differences and exact prompt acknowledgement; this function only supplies
 * the persisted run/context facts.
 */
export async function resumeReviewFixPromptDelivery(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId: string,
  context: FixPromptRecoveryContext,
  deps: FixPromptRecoveryDeps = FIX_PROMPT_RECOVERY_DEPS,
  options: {
    priorPromptSendAttempted?: boolean;
  } = {},
): Promise<FixPromptDeliveryResult> {
  assertNativeReviewOperationCurrent();
  if (!deps.getRun(runId)) return { status: 'unsupported' };
  await deps.prepareCapabilities?.(runId);
  assertNativeReviewOperationCurrent();
  if (deps.getRun(runId)?.transport === 'native') {
    if (context.taskFile)
      await withNativeReviewMutation(() =>
        deps.syncChecklistTarget(vars, path.posix.dirname(context.taskFile!), 'review-fix'),
      );
    return deliverNativeFix(runId, context.id);
  }
  const storedTarget = context.target?.target;
  const session = context.target?.session;
  const taskFile = context.taskFile;
  const runner = normalizeRunner(context.runner);
  if (
    !storedTarget ||
    !session ||
    !taskFile ||
    !runner ||
    !runnerSupportsInteractivePrompt(runner)
  ) {
    return { status: 'unsupported' };
  }

  const run = deps.getRun(runId);
  if (!run) return { status: 'unsupported' };
  const deliveryGeneration = run.engineState?.generation ?? 0;
  const taskDir = path.posix.dirname(taskFile);
  // A gateway restart can leave the shared mark helper pointed back at TASK.md
  // even though the durable fix context still owns REVIEW-FIX.md. Restore
  // the role target before any recovered prompt is delivered, otherwise a
  // completed worker writes SIGNAL.json while recovery waits forever on the
  // scoped fix signal.
  await deps.syncChecklistTarget(vars, taskDir, 'review-fix');
  const target = await deps.ensureTarget(
    vars,
    session,
    storedTarget,
    context.target?.window,
    run.flowType,
  );
  const targetSeparator = target.indexOf(':');
  const targetWindow =
    targetSeparator === -1 ? null : target.slice(targetSeparator + 1).split('.', 1)[0] || null;
  await deps.persistTarget(runId, run, {
    session,
    window: targetWindow,
    pane: null,
    target,
  });
  const targetHostsRunner = deps.targetHostsRunner
    ? await deps.targetHostsRunner(vars, target, runner, undefined, true)
    : true;
  const attemptStartedAt = context.attemptStartedAt?.trim();
  if (!attemptStartedAt) return { status: 'deferred' };
  const basePrompt = await deps.resolvePrompt(run.project, { taskFile, taskDir });
  const primaryContext = selectAgentContext(run, { role: 'primary' });
  const signalRelPath =
    context.signalFile ?? taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);
  const signalPath = `${vars.remoteRepo}/${signalRelPath}`;
  const launchAckBaseline = await deps.readLaunchAck(vars, signalPath);
  const runtimeDir = await deps.resolveRuntimeDir(run.project);
  const priorPromptSendAttempted =
    options.priorPromptSendAttempted ?? Boolean(context.promptDeliveryStartedAt);
  if (priorPromptSendAttempted && !targetHostsRunner) return { status: 'blocked' };
  const deliveryStartedAt = priorPromptSendAttempted
    ? context.promptDeliveryStartedAt
    : new Date().toISOString();
  if (!priorPromptSendAttempted && deliveryStartedAt)
    await deps.recordDeliveryBoundary?.(runId, context, deliveryStartedAt, deliveryGeneration);
  // The worker's own mark-start rewrites attemptStartedAt; the delivery boundary is the sent text.
  const prompt = reviewFixPrompt(
    basePrompt,
    taskDir,
    taskFile,
    deliveryStartedAt ?? attemptStartedAt,
  );
  const deliveryOptions = {
    vars,
    target,
    runnerId: runner,
    sessionId: primaryContext?.runnerSessionId,
    sessionPath: primaryContext?.runnerSessionPath,
    model: context.model ?? run.metrics.model,
    effort: run.effort,
    prompt,
    promptMarker: REVIEW_FIX_CHECKLIST_TARGET.checklist,
    safetyTier: run.safetyTier,
    runtimeDir,
    taskDir,
    taskFile,
    replacementReadySignalPath: primaryContext?.signalFile,
    replacementReadySignalAttemptId: primaryContext?.signalAttemptId,
    launchAckSignalPath: signalPath,
    launchAckBaseline,
    acceptExistingLaunchAck: false,
    priorPromptSendAttempted,
    timeoutMs: RUNNER_LAUNCH_READY_TIMEOUT_MS,
    recovery: { runId },
    sendLogPrefix: 'review-fix-recovery',
    forceBusyPoll: true,
  };
  let result = await deps.deliver(deliveryOptions);
  const boundaryMs = Date.parse(deliveryStartedAt ?? '');
  if (!result.delivered && priorPromptSendAttempted && Number.isFinite(boundaryMs)) {
    // A fix sent before prompts led with their identity carried this exact text, which
    // hook digests share across rounds and native readers compare whole. Probe it without
    // sending, accepting a receipt only after this delivery's own boundary.
    const legacy = await deps.deliver({
      ...deliveryOptions,
      prompt: `${basePrompt}\n\n${reviewFixProgressContract(taskDir, taskFile)}\n\nFarmslot fix delivery attempt: ${attemptStartedAt}`,
      acknowledgementSinceMs: boundaryMs - LEGACY_FIX_RECEIPT_CLOCK_TOLERANCE_MS,
    });
    if (legacy.delivered) result = legacy;
  }
  if (result.delivered) {
    if (result.acknowledgement === 'structured' && result.turnToken && deliveryStartedAt)
      await deps.rememberAcceptedTurn?.(
        runId,
        runner,
        result.turnToken,
        deliveryStartedAt,
        deliveryGeneration,
      );
    return {
      status: 'delivered',
      ...(result.turnToken ? { turnToken: result.turnToken } : {}),
    };
  }
  if (priorPromptSendAttempted) return { status: 'deferred' };
  if (
    runnerRetainedSessionHandoff(runner) === 'argv-relaunch' &&
    targetHostsRunner &&
    !result.delivered
  ) {
    return { status: 'deferred' };
  }
  return result.disposition === 'hold' && result.retryable === false
    ? { status: 'relaunch-required' }
    : { status: 'deferred' };
}

export async function reconcileRecoveredFixPromptDelivery(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId: string,
  context: FixPromptRecoveryContext,
  deps: FixPromptRecoveryDeps = FIX_PROMPT_RECOVERY_DEPS,
  {
    retryIntervalMs = 5_000,
    retryWindowMs = RUNNER_LAUNCH_READY_TIMEOUT_MS,
    readMatchingSignal,
  }: {
    retryIntervalMs?: number;
    retryWindowMs?: number;
    readMatchingSignal?: () => Promise<boolean>;
  } = {},
): Promise<FixPromptDeliveryResult | { status: 'signal-present' }> {
  const deadline = Date.now() + retryWindowMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryIntervalMs, deadline - Date.now())),
    );
    assertNativeReviewOperationCurrent();
    if (await readMatchingSignal?.()) return { status: 'signal-present' };
    const delivery = await resumeReviewFixPromptDelivery(vars, runId, context, deps, {
      priorPromptSendAttempted: true,
    });
    if (delivery.status !== 'deferred') return delivery;
  }
  return { status: 'deferred' };
}

export function canSettleRecoveredFixContext(
  current: AgentContext | undefined,
  snapshot: AgentContext,
  expectedAttemptId: string | undefined,
  artifactScope?: string | null,
): boolean {
  if (
    !current ||
    current.artifactScope !== artifactScope ||
    current.taskFile !== snapshot.taskFile ||
    current.signalFile !== snapshot.signalFile
  )
    return false;
  if (current.signalAttemptId === expectedAttemptId) return true;
  // Recovery may first observe an already-complete signal. Adopt its validated
  // identity only if no newer delivery or watcher binding replaced our snapshot.
  return (
    Boolean(expectedAttemptId) &&
    !current.signalAttemptId &&
    !snapshot.signalAttemptId &&
    current.attemptStartedAt === snapshot.attemptStartedAt &&
    current.promptDeliveryStartedAt === snapshot.promptDeliveryStartedAt
  );
}

async function recoverReviewFixPass({
  vars,
  taskDir,
  slotId,
  runId,
  start,
  reviewRunner,
  model,
  effort,
  workerRunner,
  maxRetries,
  reviewTimeoutMs,
  validationDepth,
  artifactScope,
  mode = resolveReviewMode(),
  findingsArtifactScope,
  setProgressDetail = setReviewProgressDetail,
}: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  taskDir: string;
  slotId: string;
  runId: string;
  start: number;
  reviewRunner: string;
  model: string;
  effort?: string | null;
  workerRunner: string;
  maxRetries: number;
  reviewTimeoutMs: number;
  validationDepth: ReviewValidationDepth;
  artifactScope?: string | null;
  mode?: ReviewMode;
  findingsArtifactScope?: string | null;
  setProgressDetail?: (runId: string, detail: string) => void;
}): Promise<ReviewResult | null> {
  assertNativeReviewOperationCurrent();
  const run = getRun(runId);
  const recoveryGeneration = run?.engineState?.generation ?? 0;
  const fixContext = run?.agentContexts?.find((ctx) =>
    canRecoverReviewFixPass(ctx, taskDir, findingsArtifactScope),
  );
  // Never recover from REVIEW-FIX-SIGNAL.json alone. That file is reused by every
  // review loop in the task dir, so a completed prior loop can otherwise masquerade as the
  // fix pass for a new independent review and prevent feedback from reaching the worker.
  if (!fixContext) return null;

  const settleRecoveredFixContext = async (
    status: 'complete' | 'failed' | 'blocked',
    expectedAttemptId: string | undefined,
    patch: Partial<AgentContext> = {},
  ): Promise<boolean> => {
    const updated = await withNativeReviewMutation(() =>
      upsertAgentContext(
        runId,
        'review-fix',
        { id: fixContext.id },
        {
          resolvePatch: (current) =>
            canSettleRecoveredFixContext(
              current,
              fixContext,
              expectedAttemptId,
              findingsArtifactScope,
            )
              ? {
                  id: fixContext.id,
                  status,
                  completedAt: new Date().toISOString(),
                  ...(expectedAttemptId ? { signalAttemptId: expectedAttemptId } : {}),
                  ...patch,
                }
              : null,
        },
      ),
    );
    return updated !== null;
  };

  let recoveryFailure: unknown;
  try {
    const fixSignalPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);
    const matchingFixSignal = (raw: string | null): WorkerSignal | undefined => {
      try {
        const signal = terminalWorkerSignalFromRaw(raw ?? '');
        if (!signal) return undefined;
        const matchesAttempt = fixContext.signalAttemptId
          ? signal.attemptId === fixContext.signalAttemptId
          : signalFreshSince(signal, fixContext.attemptStartedAt ?? fixContext.startedAt);
        return matchesAttempt ? signal : undefined;
      } catch (err) {
        console.warn(
          `[review] ignoring invalid recovered review fix signal for ${runId.slice(0, 8)}: ${(err as Error).message}`,
        );
        return undefined;
      }
    };
    const rawSignal = await readOptionalReviewFixSignal(vars, fixSignalPath);
    let fixSignal = matchingFixSignal(rawSignal);

    // Older contexts can be migrated only after their opaque worker attempt
    // matches. Bind the review generation then; never infer it from clocks.
    if (findingsArtifactScope && !fixContext.artifactScope) {
      if (!fixSignal) return null;
      const rebound = await upsertAgentContext(
        runId,
        'review-fix',
        { id: fixContext.id },
        {
          resolvePatch: (current) =>
            current &&
            current.attemptStartedAt === fixContext.attemptStartedAt &&
            current.signalAttemptId === fixContext.signalAttemptId &&
            !current.artifactScope
              ? { id: fixContext.id, artifactScope: findingsArtifactScope }
              : null,
        },
      );
      if (!rebound) return null;
    }

    const issues = await readReviewFixIssues(vars, taskDir);
    if (issues === null) return null;
    if (issues.length === 0) {
      await upsertAgentContext(
        runId,
        'review-fix',
        { id: fixContext.id },
        {
          resolvePatch: (current) =>
            current &&
            current.artifactScope === findingsArtifactScope &&
            current.attemptStartedAt === fixContext.attemptStartedAt &&
            current.signalAttemptId === fixContext.signalAttemptId
              ? { id: fixContext.id, status: 'failed' }
              : null,
        },
      );
      debugReviewLog(
        `[review] run ${runId.slice(0, 8)} — fix context has no materialized findings; rebuilding from the review result`,
      );
      return null;
    }
    const latestRun = getRun(runId) ?? run;
    const fixBaseSha = resolveRecoveredFixBaseSha(latestRun, fixContext, findingsArtifactScope);
    const ownerReview = latestRun?.engineState?.publishGate?.reviews?.find(
      (review) => review.id === (fixContext.artifactScope ?? findingsArtifactScope),
    );
    const priorResult: ReviewAgentResult = {
      verdict: 'issues',
      issues,
      validationDepth,
      usage: ownerReview?.usage,
      reviewSnapshot: ownerReview?.reviewSnapshot,
    };
    debugReviewLog(
      `[review] run ${runId.slice(0, 8)} — recovering review fix pass (${fixSignal ? 'signal-present' : 'waiting'})`,
    );
    setProgressDetail(
      runId,
      `Recovered reviewer findings; worker applying ${issues.length} fix(es)...`,
    );

    let expiredAttemptId: string | undefined;
    if (!fixSignal) {
      // The progress watcher below only observes checkboxes. Restore the signal
      // subscription too, so recovery can bind a new worker attempt before waiting.
      if (run?.transport !== 'native') {
        await watchContext(vars.slotId, fixContext, {
          assertCurrent: async () => assertNativeReviewOperationCurrent(),
        });
      }
      const expectedWorkerModel = resolveWorkerModel(run, workerRunner, model);
      const fixContextMatchesWorker =
        normalizeRunner(fixContext.runner) === normalizeRunner(workerRunner) &&
        (!fixContext.model?.trim() || fixContext.model.trim() === expectedWorkerModel);
      let delivery: FixPromptDeliveryResult = fixContextMatchesWorker
        ? await resumeReviewFixPromptDelivery(vars, runId, fixContext)
        : { status: 'relaunch-required' };
      if (!fixContextMatchesWorker) {
        debugReviewLog(
          `[review] run ${runId.slice(0, 8)} — fix context ${fixContext.runner}/${fixContext.model ?? 'default'} does not match worker ${workerRunner}/${expectedWorkerModel}; relaunching with worker model`,
        );
      }
      debugReviewLog(`[review] run ${runId.slice(0, 8)} — recovered fix prompt ${delivery.status}`);
      if (delivery.status === 'relaunch-required') {
        const relaunched = await relaunchWorkerForFix(vars, workerRunner, model, runId);
        if (relaunched) {
          const relaunchedFixContext =
            getRun(runId)?.agentContexts?.find(
              (candidate) => candidate.role === 'review-fix' && candidate.taskFile,
            ) ?? fixContext;
          delivery = await resumeReviewFixPromptDelivery(
            vars,
            runId,
            relaunchedFixContext,
            FIX_PROMPT_RECOVERY_DEPS,
            { priorPromptSendAttempted: false },
          );
        } else {
          delivery = { status: 'deferred' };
        }
        debugReviewLog(
          `[review] run ${runId.slice(0, 8)} — recovered fix prompt fresh-worker ${delivery.status}`,
        );
      }
      if (delivery.status === 'deferred') {
        if (fixContextMatchesWorker && fixContext.promptDeliveryStartedAt) {
          setProgressDetail(
            runId,
            'Recovered reviewer findings; reconciling fix prompt acknowledgement...',
          );
          const reconciled = await reconcileRecoveredFixPromptDelivery(
            vars,
            runId,
            fixContext,
            FIX_PROMPT_RECOVERY_DEPS,
            {
              readMatchingSignal: async () => {
                fixSignal = matchingFixSignal(
                  await readOptionalReviewFixSignal(vars, fixSignalPath),
                );
                return Boolean(fixSignal);
              },
            },
          );
          if (reconciled.status !== 'signal-present') delivery = reconciled;
        } else {
          setProgressDetail(
            runId,
            `Recovered reviewer findings; fix prompt delivery deferred while worker is busy...`,
          );
        }
      }
      if (delivery.status === 'blocked') {
        fixSignal = matchingFixSignal(await readOptionalReviewFixSignal(vars, fixSignalPath));
        if (!fixSignal) {
          if (
            !(await settleRecoveredFixContext('blocked', fixContext.signalAttemptId ?? undefined))
          )
            return null;
          return {
            verdict: 'blocked',
            reason: 'Recovered review fix worker exited without a terminal signal',
            issues,
            validationDepth,
            retryCount: 1,
            maxRetries,
            feedbackSent: true,
            attempts: [
              {
                mode,
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: issues.length,
                issues,
                validationDepth,
              },
            ],
            durationMs: Date.now() - start,
          };
        }
      }
      if (!fixSignal) {
        const fixActive =
          delivery.status === 'delivered' &&
          delivery.turnToken &&
          (await reviewFixTurnIsActive(vars, runId, workerRunner, delivery.turnToken));
        if (runSupersededSince(getRun(runId), recoveryGeneration)) return null;
        updateRun(runId, { status: fixActive ? 'fixing' : 'reconciling' });
        const fixTaskPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
        const fixWatcher = startProgressWatcher(vars, fixTaskPath, runId, 'Fix', {
          isCurrent: captureNativeReviewOperationCheck(),
        });
        let waitFailure: unknown;
        try {
          const deliveredTurnToken =
            delivery.status === 'delivered' ? delivery.turnToken : undefined;
          fixSignal = await waitForWorkerSignal(
            vars,
            taskDir,
            FEEDBACK_TIMEOUT_MS,
            rawSignal ?? '',
            deliveredTurnToken
              ? () => reviewFixTurnIsActive(vars, runId, workerRunner, deliveredTurnToken)
              : undefined,
            () =>
              getRun(runId)?.agentContexts?.find((context) => context.id === fixContext.id)
                ?.signalAttemptId ?? undefined,
            (attemptId) => {
              expiredAttemptId = attemptId;
            },
          );
        } catch (error) {
          waitFailure = error;
          throw error;
        } finally {
          await finishReviewCleanup(waitFailure, [() => fixWatcher.stop()]);
        }
      }
    }

    if (!fixSignal) {
      debugReviewLog(
        `[review] run ${runId.slice(0, 8)} — timeout waiting for recovered worker fix`,
      );
      if (!expiredAttemptId || !(await settleRecoveredFixContext('failed', expiredAttemptId)))
        return null;
      // Keep the path-scoped watch alive for a same-run successor attempt. A running
      // signal can adopt a new opaque attempt immediately after the settlement CAS;
      // role-scoped teardown here would then remove the successor's observability.
      if (maxRetries <= 1)
        return {
          verdict: 'issues',
          issues,
          validationDepth,
          retryCount: 1,
          maxRetries,
          feedbackSent: true,
          attempts: [
            {
              mode,
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: issues.length,
              validationDepth,
            },
          ],
          durationMs: Date.now() - start,
        };
      return await runReviewRetryLoop({
        vars,
        taskDir,
        slotId,
        runId,
        start,
        workerRunner,
        reviewRunner,
        model,
        effort,
        maxRetries,
        reviewTimeoutMs,
        reviewResult: { verdict: 'issues', issues, validationDepth },
        retryCount: 1,
        validationDepth,
        artifactScope,
        mode,
        feedbackAlreadySent: true,
      });
    }

    // The watcher can bind an attempt id after recovery starts. Use the terminal
    // signal's authoritative id instead of the entry-time context snapshot, or
    // the settlement CAS can discard a fix that actually completed.
    const terminalAttemptId = fixSignal.attemptId ?? fixContext.signalAttemptId;

    const workerBlockReason =
      fixSignal.status === 'blocked'
        ? (fixSignal.reason ?? 'worker blocked during review fix')
        : null;
    if (
      !(await settleRecoveredFixContext(
        fixSignal.status === 'blocked'
          ? 'blocked'
          : fixSignal.status === 'failed'
            ? 'failed'
            : 'complete',
        terminalAttemptId,
        { lastSignalAt: new Date().toISOString() },
      ))
    )
      return null;
    // Keep the reusable fix-context watch; the next review round uses the same files.
    const fixDelta = await withNativeReviewMutation(() =>
      captureFixDeltaSnapshot(vars, taskDir, 2, fixBaseSha, artifactScope),
    );
    if (runSupersededSince(getRun(runId), recoveryGeneration)) return null;
    const initialAttempt: ReviewAttempt = {
      mode,
      loopNumber: 1,
      verdict: 'issues',
      unresolvedCount: issues.length,
      issues,
      validationDepth,
      ...(ownerReview?.reviewSnapshot ? { reviewSnapshot: ownerReview.reviewSnapshot } : {}),
    };
    if (workerBlockReason && fixDeltaIsKnownEmpty(fixDelta.snapshot)) {
      return {
        verdict: 'blocked',
        reason: workerBlockReason,
        issues,
        validationDepth,
        retryCount: 1,
        maxRetries,
        fixDelta: fixDelta.snapshot,
        attempts: [
          initialAttempt,
          {
            mode,
            loopNumber: 2,
            verdict: 'failed',
            unresolvedCount: issues.length,
            issues,
            validationDepth,
            fixDelta: fixDelta.snapshot,
            artifactPaths: fixDelta.artifactPaths,
          },
        ],
        feedbackSent: true,
        durationMs: Date.now() - start,
      };
    }
    setProgressDetail(
      runId,
      `${workerBlockReason ? 'Worker made partial fixes before blocking' : 'Worker fix complete'}; running ${reviewRunner} re-review (2)...`,
    );
    updateRun(runId, { status: 'reviewing' });
    const retryResult = await runReviewAgent(
      vars,
      reviewRunner,
      model,
      taskDir,
      slotId,
      runId,
      reviewTimeoutMs,
      2,
      validationDepth,
      artifactScope,
      mode,
      effort,
      ownerReview?.id,
    );
    const seededReviewResult = {
      ...retryResult,
      fixDelta: fixDelta.snapshot,
      artifactPaths: [...(retryResult.artifactPaths ?? []), ...fixDelta.artifactPaths],
    };
    if (workerBlockReason) {
      const reviewed = retryResult.incomplete ? priorResult : retryResult;
      const pending =
        !retryResult.incomplete &&
        retryResult.verdict === 'issues' &&
        retryResult.issues.length > 0;
      const secondAttempt = blockedReviewAttempt(
        reviewAttemptFromResult(retryResult, 2, fixDelta.snapshot, fixDelta.artifactPaths),
        workerBlockReason,
      );
      return {
        verdict: 'blocked',
        reason: workerBlockReason,
        issues: reviewed.issues,
        validationDepth,
        usage: reviewed.usage,
        reviewSnapshot: reviewed.reviewSnapshot,
        fixDelta: fixDelta.snapshot,
        attempts: [initialAttempt, secondAttempt],
        timeline: secondAttempt.timeline,
        retryCount: 1,
        maxRetries,
        feedbackSent: !pending,
        recoveryContinuationPending: pending,
        durationMs: Date.now() - start,
      };
    }
    return await runReviewRetryLoop({
      vars,
      taskDir,
      slotId,
      runId,
      start,
      workerRunner,
      reviewRunner,
      model,
      effort,
      maxRetries,
      reviewTimeoutMs,
      reviewResult: seededReviewResult,
      retryCount: 1,
      validationDepth,
      artifactScope,
      mode,
      feedbackAlreadySent: true,
    });
  } catch (error) {
    recoveryFailure = error;
    throw error;
  } finally {
    const parentRun = getRun(runId);
    await finishReviewCleanup(recoveryFailure, [
      async () => {
        if (!nativeReviewOperationIsCurrent()) return;
        await withNativeReviewMutation(() =>
          restoreWorkerChecklistTargetFromSlot(
            vars,
            taskDir,
            parentRun
              ? { flowType: parentRun.flowType, mode: parentRun.mode ?? undefined }
              : undefined,
          ),
        );
      },
    ]);
  }
}

// ─── Feedback to worker ───

export interface FixDeliveryRetryResult {
  sent: boolean;
  /** Target the last send went to — may differ from the stored one after re-resolution. */
  target: string;
  /** Total send attempts including the initial deferred one. */
  attempts: number;
  /** Session pane inventory from the last re-resolution, for terminal errors. */
  seenWindows: string[];
}

/**
 * Retry a deferred fix-task send until it lands or the window closes. Before
 * each retry the worker pane is re-resolved until a prompt might have been
 * sent, then retries remain bound to that pane. Bails early when the run
 * reaches a terminal status underneath the loop.
 */
export async function retryDeferredFixDelivery({
  runId,
  target,
  send,
  rediscover,
  persistTarget,
  getRun: getRunDep,
  shouldAbort = () => false,
  isTargetBound = () => false,
  deferredReason,
  retryIntervalMs = REVIEW_DELIVERY_RETRY_INTERVAL_MS,
  retryWindowMs = REVIEW_DELIVERY_RETRY_WINDOW_MS,
}: {
  runId: string;
  target: string;
  send: (target: string) => Promise<boolean>;
  rediscover: (storedTarget: string) => Promise<WorkerPaneRediscovery>;
  persistTarget: (target: string, window: string | null) => Promise<void>;
  getRun: typeof getRun;
  shouldAbort?: () => boolean;
  isTargetBound?: () => boolean;
  deferredReason?: () => string | null;
  retryIntervalMs?: number;
  retryWindowMs?: number;
}): Promise<FixDeliveryRetryResult> {
  const deadline = Date.now() + retryWindowMs;
  let currentTarget = target;
  let sent = false;
  let attempt = 1;
  let seenWindows: string[] = [];
  while (!sent && !shouldAbort() && Date.now() < deadline) {
    const current = getRunDep(runId);
    if (!current || isTerminalRunStatus(current.status)) {
      console.warn(
        `[review] run ${runId.slice(0, 8)} — abandoning fix delivery retries: run is ${current?.status ?? 'gone'}`,
      );
      break;
    }
    attempt += 1;
    console.warn(
      `[review] run ${runId.slice(0, 8)} — fix task send deferred (attempt ${attempt - 1}); ${deferredReason?.() || 'delivery not yet acknowledged'}, retrying in ${retryIntervalMs / 1000}s`,
    );
    await new Promise((r) => setTimeout(r, retryIntervalMs));
    if (!isTargetBound()) {
      const rediscovery = await rediscover(currentTarget);
      if (rediscovery.seenWindows.length > 0) seenWindows = rediscovery.seenWindows;
      if (rediscovery.target && rediscovery.target !== currentTarget) {
        console.warn(
          `[review] run ${runId.slice(0, 8)} — fix delivery target ${currentTarget} no longer hosts the runner; adopting ${rediscovery.target}`,
        );
        currentTarget = rediscovery.target;
        await persistTarget(currentTarget, rediscovery.window);
      }
    }
    sent = await send(currentTarget);
  }
  return { sent, target: currentTarget, attempts: attempt, seenWindows };
}

async function sendFeedbackToWorker(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  issues: ReviewIssue[],
  taskDir: string,
  runId: string,
  fixBaseSha: string | null,
  findingsArtifactScope?: string | null,
): Promise<FixDeliveryAcceptance> {
  return withNativeReviewMutation(() =>
    sendOwnedFeedbackToWorker(vars, issues, taskDir, runId, fixBaseSha, findingsArtifactScope),
  );
}

async function sendOwnedFeedbackToWorker(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  issues: ReviewIssue[],
  taskDir: string,
  runId: string,
  fixBaseSha: string | null,
  findingsArtifactScope?: string | null,
): Promise<FixDeliveryAcceptance> {
  assertNativeReviewOperationCurrent();
  const run = getRun(runId);
  const project = run?.project;
  if (!project) throw new Error(`Cannot send review feedback without a project for run ${runId}`);
  await prepareRetainedRunCapabilities(runId);
  assertNativeReviewOperationCurrent();

  const runtimeDir = await resolveProjectRuntimeDir(project);
  const expanded = await expandReviewFixTemplate(vars, taskDir, run, issues);

  // Clear any stale fix-pass signal before sending new feedback.
  const fixSignalPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);
  const priorPrimaryContext = run ? selectAgentContext(run, { role: 'primary' }) : null;
  const priorFixContext = run?.agentContexts?.find(
    (context) => context.role === 'review-fix' && context.signalFile,
  );
  const replacementOwner = priorFixContext ?? priorPrimaryContext;
  const replacementReadySignal = replacementOwner?.signalFile
    ? await readLaunchAckSignalSnapshot(vars, replacementOwner.signalFile)
    : null;
  assertNativeReviewOperationCurrent();
  await removeSlotFiles(vars, [fixSignalPath]);
  const fixSignalBaseline = await readOptionalSlotFile(vars, fixSignalPath);
  const fixLaunchAckBaseline = await readLaunchAckSignalSnapshot(vars, fixSignalPath);
  assertNativeReviewOperationCurrent();

  // Write the fix task to a file on the slot
  await writeTextFileOnSlot(
    vars,
    taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist),
    expanded,
  );
  await syncChecklistTargetForRole(vars, taskDir, 'review-fix');
  assertNativeReviewOperationCurrent();

  const fixTaskRel = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
  if (run.transport === 'native') {
    const attemptStartedAt = new Date().toISOString();
    const basePrompt = await resolveWorkerDispatchPrompt(project, {
      taskFile: fixTaskRel,
      taskDir,
    });
    const context = await prepareNativeFix({
      runId,
      taskFile: fixTaskRel,
      signalFile: taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal),
      attemptStartedAt,
      prompt: reviewFixPrompt(basePrompt, taskDir, fixTaskRel, attemptStartedAt),
      fixBaseSha,
      artifactScope: findingsArtifactScope,
    });
    const deadline = Date.now() + RUNNER_LAUNCH_READY_TIMEOUT_MS;
    do {
      const delivery = await deliverNativeFix(runId, context.id);
      if (delivery.status === 'delivered')
        return { signalBaseline: fixSignalBaseline, turnToken: delivery.turnToken };
      if (delivery.status === 'relaunch-required') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    // Keep the durable attempt and checklist selected while acceptance is uncertain.
    throw new ReviewFixDeliveryError('Native fix acceptance needs reconciliation');
  }
  try {
    // Mark REVIEW-FIX.md as the active task file for progress tracking
    updateRun(runId, { activeTaskFile: fixTaskRel });
    const primaryTarget = await resolveAgentTarget(vars.slotId, { runId, role: 'primary' });
    const session = primaryTarget.session;
    const currentRun = getRun(runId);
    const primaryContext = currentRun ? selectAgentContext(currentRun, { role: 'primary' }) : null;
    const roleWindowName = primaryContext?.target?.window ?? null;
    let workerTarget = await ensureTmuxTargetReadyForRelaunch(
      vars,
      session,
      primaryTarget.target,
      roleWindowName,
      run?.flowType,
    );
    // Derive the window name from the primary worker's target so resolveAgentTarget
    // can route back to the correct pane if the stored context is used.
    const workerWindowSep = workerTarget.indexOf(':');
    const workerWindow =
      workerWindowSep === -1
        ? null
        : workerTarget.slice(workerWindowSep + 1).split('.', 1)[0] || null;
    const fixAttemptStartedAt = new Date().toISOString();
    const fixContext = await upsertAgentContext(runId, 'review-fix', {
      status: 'working',
      attemptStartedAt: fixAttemptStartedAt,
      artifactScope: findingsArtifactScope,
      signalAttemptId: undefined,
      promptDeliveryStartedAt: undefined,
      promptAcceptance: undefined,
      deliveryBaselineRef: fixBaseSha ?? undefined,
      taskFile: taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist),
      signalFile: taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal),
      runner: run?.metrics.runner ?? null,
      model: run?.metrics.model ?? null,
      target: { session, window: workerWindow, pane: null, target: workerTarget },
    });
    if (fixContext) await watchContext(vars.slotId, fixContext);

    // Send single-line command to the worker's original pane
    const fixTaskFile = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
    const baseCmd = await resolveWorkerDispatchPrompt(project, {
      taskFile: fixTaskFile,
      taskDir,
    });
    const runner = normalizeRunner(run?.metrics.runner);
    let lastRetainedHoldReason: string | null = null;
    let terminalRetainedHoldReason: string | null = null;
    let structuredDeliveryAccepted = false;
    let acceptedTurnToken: string | undefined;
    let acceptedDeliveryStartedAt: string | undefined;
    let acceptedGeneration: number | undefined;
    let promptSendAttempted = false;
    let deliveryBoundaryRecorded = false;
    const loggedRetainedHoldReasons = new Set<string>();
    const deliverFixPrompt = async (target: string, forceBusyPoll = false): Promise<boolean> => {
      if (terminalRetainedHoldReason) return false;
      // One boundary per attempt: the prompt text follows it, and a retry must never type a
      // different text over an earlier one left in the composer.
      if (!deliveryBoundaryRecorded) {
        await upsertAgentContext(runId, 'review-fix', {
          id: fixContext?.id,
          promptDeliveryStartedAt: new Date().toISOString(),
        });
        deliveryBoundaryRecorded = true;
      }
      const latestRun = getRun(runId);
      const latestPrimaryContext = latestRun
        ? selectAgentContext(latestRun, { role: 'primary' })
        : null;
      const deliveryStartedAt = latestRun?.agentContexts?.find(
        (entry) => entry.id === fixContext?.id,
      )?.promptDeliveryStartedAt;
      const deliveryOptions = {
        vars,
        target,
        runnerId: runner,
        sessionId: latestPrimaryContext?.runnerSessionId,
        sessionPath: latestPrimaryContext?.runnerSessionPath,
        model: latestRun?.metrics.model,
        effort: latestRun?.effort,
        prompt: reviewFixPrompt(
          baseCmd,
          taskDir,
          fixTaskFile,
          deliveryStartedAt ?? fixAttemptStartedAt,
        ),
        safetyTier: latestRun?.safetyTier,
        runtimeDir,
        taskDir,
        taskFile: fixTaskFile,
        replacementReadySignalPath: replacementOwner?.signalFile,
        replacementReadySignalAttemptId: replacementOwner?.signalAttemptId,
        replacementReadySignal,
        launchAckSignalPath: fixSignalPath,
        launchAckBaseline: fixLaunchAckBaseline,
        priorPromptSendAttempted: promptSendAttempted,
        recovery: { runId },
        sendLogPrefix: 'review',
        forceBusyPoll,
      };
      const deliveryGeneration = latestRun?.engineState?.generation ?? 0;
      const retained = await deliverPromptToLiveRunner({
        ...deliveryOptions,
        promptMarker: REVIEW_FIX_CHECKLIST_TARGET.checklist,
      });
      promptSendAttempted =
        promptSendAttempted || retained.delivered || retained.sendAttempted === true;
      if (retained.delivered) {
        structuredDeliveryAccepted = retained.acknowledgement === 'structured';
        acceptedTurnToken = retained.turnToken;
        acceptedDeliveryStartedAt = deliveryStartedAt;
        acceptedGeneration = deliveryGeneration;
        return true;
      }
      if (retained.disposition === 'hold') {
        lastRetainedHoldReason = retained.reason;
        if (retained.retryable === false) terminalRetainedHoldReason = retained.reason;
        if (!loggedRetainedHoldReasons.has(retained.reason)) {
          loggedRetainedHoldReasons.add(retained.reason);
          console.warn(`[review] retained worker handoff held: ${retained.reason}`);
        }
        return false;
      }
      return false;
    };
    let sent = await deliverFixPrompt(workerTarget);
    let deliverySeenWindows: string[] = [];
    if (!sent && !terminalRetainedHoldReason) {
      // A busy worker is the NORMAL state of a healthy worker — it is usually
      // busy doing this very run's work when the review lands. Two immediate
      // probes failed the same run three times in one day (02866fe6) while the
      // worker was mid-merge and picked the task up instantly once idle. So:
      // keep retrying on an interval until the worker accepts or the window
      // closes, bailing early if the run is cancelled underneath us. Each
      // retry re-resolves the worker pane until a send has been attempted.
      const retry = await retryDeferredFixDelivery({
        runId,
        target: workerTarget,
        send: (retryTarget) => deliverFixPrompt(retryTarget, true),
        rediscover: (storedTarget) =>
          rediscoverAcceptingWorkerPane(vars, session, runner, storedTarget),
        persistTarget: async (adopted, window) => {
          const corrected = { session, window, pane: null, target: adopted };
          await upsertAgentContext(runId, 'review-fix', { target: corrected });
          // Route later role-targeted sends to the same pane — but never
          // fabricate a primary context that dispatch did not create.
          const workerRole = primaryRoleForFlow(getRun(runId)?.flowType);
          if (getRun(runId)?.agentContexts?.some((ctx) => ctx.role === workerRole)) {
            await upsertAgentContext(runId, workerRole, { target: corrected });
          }
        },
        getRun,
        shouldAbort: () => terminalRetainedHoldReason != null,
        isTargetBound: () => promptSendAttempted,
        deferredReason: () => lastRetainedHoldReason,
      });
      sent = retry.sent;
      workerTarget = retry.target;
      deliverySeenWindows = retry.seenWindows;
      console.log(
        `[review] run ${runId.slice(0, 8)} — fix task ${sent ? `sent after ${retry.attempts} attempt(s)` : `NOT delivered after ${retry.attempts} attempt(s) over ${Math.round(REVIEW_DELIVERY_RETRY_WINDOW_MS / 60_000)}min`}: ${fixTaskFile}`,
      );
    } else if (sent) {
      // Always-on: delivery state is the first question when a fix loop stalls.
      console.log(`[review] run ${runId.slice(0, 8)} — fix task sent: ${fixTaskFile}`);
    }
    if (!sent) {
      // Waiting on a fix the worker never received would burn the whole
      // FEEDBACK_TIMEOUT; fail loudly instead. Clear the fix context created
      // above (it was optimistically marked working and watched); the catch
      // below restores the worker checklist target and active task file.
      await markAgentContextStatus(runId, 'review-fix', 'failed');
      await unwatchContext(vars.slotId, 'review-fix');
      const seenSummary =
        deliverySeenWindows.length > 0 ? deliverySeenWindows.join('; ') : 'none inspected';
      const retainedSummary = lastRetainedHoldReason
        ? ` Retained-session handoff: ${lastRetainedHoldReason}.`
        : '';
      const failureSummary = terminalRetainedHoldReason
        ? 'review fix task delivery stopped after the retained runner was replaced but did not acknowledge the prompt'
        : `review fix task delivery kept deferring for ${Math.round(REVIEW_DELIVERY_RETRY_WINDOW_MS / 60_000)}min — worker never accepted the prompt`;
      throw new ReviewFixDeliveryError(
        `${failureSummary} (${fixTaskFile}).${retainedSummary} Pane re-resolution found no accepting runner pane in session ${session} (windows seen: ${seenSummary}). Escape: replay the review step after restoring runner observability.`,
      );
    }
    await recordReviewFixRunnerSession(vars, runId, runner, workerTarget);
    if (structuredDeliveryAccepted) {
      if (acceptedTurnToken && acceptedDeliveryStartedAt && acceptedGeneration !== undefined)
        await rememberReviewFixTurn(
          runId,
          runner,
          acceptedTurnToken,
          acceptedDeliveryStartedAt,
          acceptedGeneration,
        );
      return {
        signalBaseline: fixSignalBaseline,
        ...(acceptedTurnToken ? { turnToken: acceptedTurnToken } : {}),
      };
    }
    // sent=true only proves keystrokes were injected and Enter pressed. Without a
    // prompt receipt, only the worker's own fix signal proves it took the task: a
    // busy pane keeps changing while the prompt can still sit unsent in its composer.
    const acknowledged = await workerAcknowledgesFixTask(async () => {
      const raw = await readOptionalSlotFile(vars, fixSignalPath);
      return raw != null && raw !== fixSignalBaseline;
    });
    if (!acknowledged) {
      console.warn(
        `[review] run ${runId.slice(0, 8)} — fix task sent but the worker wrote no fix signal within ${REVIEW_DELIVERY_PROBE_TIMEOUT_MS / 1000}s; treating as delivery failure`,
      );
      await markAgentContextStatus(runId, 'review-fix', 'failed');
      await unwatchContext(vars.slotId, 'review-fix');
      throw new ReviewFixDeliveryError(
        `review fix task was sent but the worker never acknowledged it: no prompt receipt and no fix signal (${fixTaskFile})`,
      );
    }
    return { signalBaseline: fixSignalBaseline };
  } catch (err) {
    await restoreWorkerChecklistTargetFromSlot(
      vars,
      taskDir,
      run ? { flowType: run.flowType, mode: run.mode ?? undefined } : undefined,
    );
    clearRunActiveTaskFile(runId, fixTaskRel);
    throw err;
  }
}

// ─── Helpers ───

/** Retain the existing delivery receipt so later gate reads can bind the same turn. */
async function rememberReviewFixTurn(
  runId: string,
  runner: string,
  turnToken: string,
  deliveryStartedAt: string,
  generation: number,
): Promise<void> {
  const run = getRun(runId);
  const fix = run && selectAgentContext(run, { role: 'review-fix' });
  if (!run || !fix?.runnerSessionId || !fix.runnerSessionPath) return;
  if (runSupersededSince(run, generation)) return;
  const promptAcceptance = {
    runner,
    deliveryStartedAt,
    turnToken,
    observedAt: Date.now(),
    sessionId: fix.runnerSessionId,
    sessionPath: fix.runnerSessionPath,
  };
  await upsertAgentContext(
    runId,
    'review-fix',
    { id: fix.id },
    {
      guard: async () => !runSupersededSince(getRun(runId), generation),
      resolvePatch: (current) =>
        current?.promptDeliveryStartedAt === deliveryStartedAt &&
        current.runnerSessionId === fix.runnerSessionId &&
        current.runnerSessionPath === fix.runnerSessionPath
          ? { promptAcceptance }
          : null,
      mirrorIf: (slot) => slot.current_run_id === runId,
    },
  );
}

const REVIEW_DELIVERY_PROBE_TIMEOUT_MS = 60_000;
// Fix-task delivery retry: a worker mid-task is busy for minutes, not seconds.
// 30s spacing over a 15min window rides out a long merge/validation turn; the
// loop bails early when the run is cancelled underneath it.
const REVIEW_DELIVERY_RETRY_INTERVAL_MS = 30_000;
const REVIEW_DELIVERY_RETRY_WINDOW_MS = 15 * 60_000;
const REVIEW_DELIVERY_PROBE_POLL_MS = 5_000;
// Observed wedges hit at ~90%+ context usage (260–292k tokens); relaunch below that.
const REVIEW_FIX_RELAUNCH_CTX_PCT = 90;

async function readWorkerContextPct(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  runId: string,
): Promise<number | null> {
  if (getRun(runId)?.transport === 'native') return null;
  const provider = getRunnerStatusProvider(runner);
  if (!provider) return null;
  try {
    const resolved = await resolveAgentTarget(vars.slotId, { runId, role: 'primary' });
    return await provider.getContextPct(vars, resolved.target);
  } catch (err) {
    // The ctx reading is an optional pre-check: null means "unknown" and the
    // post-send responsiveness probe still guards the wedged-REPL case, so a
    // failed probe must not abort the fix loop.
    console.warn(
      `[review] run ${runId.slice(0, 8)} — context-pct probe failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/** Polls the worker's fix signal, the only acknowledgement left without a prompt receipt. */
async function workerAcknowledgesFixTask(signalChanged: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + REVIEW_DELIVERY_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, REVIEW_DELIVERY_PROBE_POLL_MS));
    if (await signalChanged()) return true;
  }
  return signalChanged();
}

/**
 * Bind the review-fix role to the runner session that just accepted the
 * fix prompt. A retained worker keeps its own session, so the fix role adopts
 * it; a fix relaunch respawned the runner, so the new session is captured
 * against the delivery pane and bound to the worker role as well — that role's
 * previous binding was cleared by the respawn and would otherwise stay empty.
 */
async function recordReviewFixRunnerSession(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId: string,
  runner: string,
  deliveryTarget: string,
): Promise<void> {
  const latest = getRun(runId);
  const workerRole = primaryRoleForFlow(latest?.flowType);
  const workerContext = latest?.agentContexts?.find((ctx) => ctx.role === workerRole);
  const retained = resolvePersistedRunnerSessionBinding([
    {
      label: 'retained review worker context',
      runnerSessionId: workerContext?.runnerSessionId,
      runnerSessionPath: workerContext?.runnerSessionPath,
    },
  ]);
  if (retained.binding) {
    await recordRunnerSessionForRole({
      runId,
      role: 'review-fix',
      session: retained.binding,
      captureLabel: 'retained review worker session',
    });
    return;
  }
  const deliveryPane = await resolveExactTmuxWindowPane(vars, deliveryTarget);
  const relaunched = await captureAndRecordRunnerSession({
    vars,
    runner,
    runId,
    role: 'review-fix',
    captureLabel: 'review fix relaunch',
    capture: { paneId: deliveryPane?.paneId ?? null, slotId: vars.slotId },
  });
  if (workerContext) {
    await recordRunnerSessionForRole({
      runId,
      role: workerRole,
      session: relaunched,
      captureLabel: 'review fix relaunch',
    });
  }
}

async function relaunchWorkerForFix(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  model: string,
  runId: string,
): Promise<boolean> {
  assertNativeReviewOperationCurrent();
  await prepareRetainedRunCapabilities(runId);
  assertNativeReviewOperationCurrent();
  if (getRun(runId)?.transport === 'native') {
    await resumeNativeWorker(runId, {
      purpose: 'review-fix',
      assertCurrent: assertNativeReviewOperationCurrent,
    });
    return isWorkerAlive(vars, runner, runId);
  }
  const resolved = await resolveAgentTarget(vars.slotId, { runId, role: 'primary' });
  const parentRun = getRun(runId);
  const effectiveModel = resolveWorkerModel(parentRun, runner, model);
  const roleWindowName =
    parentRun?.agentContexts?.find((ctx) => ctx.role === primaryRoleForFlow(parentRun?.flowType))
      ?.target?.window ?? null;
  const workerTarget = await ensureTmuxTargetReadyForRelaunch(
    vars,
    resolved.session,
    resolved.target,
    roleWindowName,
    parentRun?.flowType,
  );
  const fixContext = parentRun?.agentContexts?.find(
    (context) => context.role === 'review-fix' && context.taskFile,
  );
  const prompt =
    parentRun?.project && fixContext?.taskFile && fixContext.attemptStartedAt
      ? reviewFixPrompt(
          await resolveWorkerDispatchPrompt(parentRun.project, {
            taskFile: fixContext.taskFile,
            taskDir: path.posix.dirname(fixContext.taskFile),
          }),
          path.posix.dirname(fixContext.taskFile),
          fixContext.taskFile,
          fixContext.promptDeliveryStartedAt ?? fixContext.attemptStartedAt,
        )
      : 'Continue working on the current TASK.md and review fix feedback.';
  // Inherit parent run's safety tier (ADR-023) so the relaunch stays on the same posture.
  const parentSafetyTier = parentRun?.safetyTier;
  const runtimeDir = await resolveProjectRuntimeDir(parentRun?.project);
  await ensureNodeSupportBundle(vars, runtimeDir);
  const taskDir = parentRun
    ? await resolveWorkerTaskDir(vars, parentRun.project, parentRun.taskFile)
    : null;
  let launchCmd = buildLaunchCommand(vars, runner, effectiveModel, prompt, {
    effort: parentRun?.effort,
    safetyTier: parentSafetyTier,
    runtimeDir,
    taskDir: taskDir ?? undefined,
    taskFile: fixContext?.taskFile ?? parentRun?.activeTaskFile ?? parentRun?.taskFile ?? undefined,
  });
  launchCmd = `${WORKER_ENV_PREFIX} && ${launchCmd}`;
  await respawnTmuxWindowWithCommand(vars, workerTarget, launchCmd, {
    preserveWindowAfterExit: true,
  });
  await new Promise((r) => setTimeout(r, TMUX_WINDOW_RESPAWN_SETTLE_MS));
  const run = getRun(runId);
  const workerRole = resolved.role ?? primaryRoleForFlow(run?.flowType);
  const windowSeparator = workerTarget.indexOf(':');
  const window =
    windowSeparator === -1
      ? null
      : workerTarget.slice(windowSeparator + 1).split('.', 1)[0] || null;
  await upsertAgentContext(runId, workerRole, {
    status: 'working',
    runner,
    model: effectiveModel,
    ...clearedRunnerSessionContextPatch(),
    target: {
      session: resolved.session,
      window,
      pane: null,
      target: workerTarget,
    },
  });
  if (fixContext) {
    const updatedFixContext = await upsertAgentContext(runId, 'review-fix', {
      status: 'working',
      runner,
      model: effectiveModel,
      target: {
        session: resolved.session,
        window,
        pane: null,
        target: workerTarget,
      },
    });
    if (updatedFixContext) await watchContext(vars.slotId, updatedFixContext);
  }

  if (!runnerNeedsPostLaunchPrompt(runner)) {
    // Never trust the respawn blindly (ported from ci-monitor, PR #326): a
    // failed launch command leaves a bare shell in the pane, and every later
    // fix prompt lands in zsh instead of a runner.
    const verifyDeadline = Date.now() + RUNNER_LAUNCH_READY_TIMEOUT_MS;
    while (Date.now() < verifyDeadline) {
      if (await isWorkerAlive(vars, runner, runId)) {
        debugReviewLog(`[review] worker re-launched (${runner})`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn(
      `[review] run ${runId.slice(0, 8)} — relaunch left no live ${runner} session in ${workerTarget}; treating relaunch as failed`,
    );
    // The context was optimistically marked working above — correct it so a
    // failed launch doesn't leave a stale working status behind.
    await markAgentContextStatus(runId, workerRole, 'failed');
    return false;
  }

  const readyTimeout = RUNNER_LAUNCH_READY_TIMEOUT_MS;
  const readyStart = Date.now();
  while (Date.now() - readyStart < readyTimeout) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isWorkerAlive(vars, runner, runId)) {
      debugReviewLog(
        `[review] worker re-launched (${runner}) in ${Math.round((Date.now() - readyStart) / 1000)}s`,
      );
      return true;
    }
    const pane = (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`capture-pane -p -t ${shellQuote(workerTarget)} 2>/dev/null | tail -8`),
      )
    ).stdout;
    const tailLines = pane
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-5);
    if (tailLines.some((line) => runnerLineLooksWaiting(line, runner))) {
      debugReviewLog(
        `[review] worker re-launched in ${Math.round((Date.now() - readyStart) / 1000)}s`,
      );
      return true;
    }
  }
  console.warn(`[review] worker re-launch timed out after ${readyTimeout}ms`);
  // Same correction as the no-prompt branch: don't leave the optimistically
  // "working" primary context behind on a failed relaunch.
  await markAgentContextStatus(runId, workerRole, 'failed');
  return false;
}

export async function waitForWorkerSignal(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  timeoutMs: number,
  baseline: string,
  turnActive?: () => Promise<boolean>,
  expectedAttemptId?: string | (() => string | undefined),
  onTimeout?: (expiredAttemptId: string | undefined) => void,
): Promise<WorkerSignal | undefined> {
  const signalPath = slotTaskRelPath(vars, taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);

  const start = Date.now();
  let lastProgressAt = start;
  let lastObservedSignal = baseline;
  let lastExpectedAttemptId =
    typeof expectedAttemptId === 'function' ? expectedAttemptId() : expectedAttemptId;
  let nextTurnStateCheckAt = start;
  const turnStatePollMs = Math.min(10_000, Math.max(2_000, Math.floor(timeoutMs / 2)));
  const maxActiveMs = Math.max(timeoutMs, Math.min(FEEDBACK_MAX_ACTIVE_MS, timeoutMs * 4));
  while (Date.now() - start < maxActiveMs && Date.now() - lastProgressAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    assertNativeReviewOperationCurrent();
    const expected =
      typeof expectedAttemptId === 'function' ? expectedAttemptId() : expectedAttemptId;
    if (expected !== lastExpectedAttemptId) {
      // Reconsider the current file when the context watcher adopts a new attempt.
      // The terminal write can race that persisted adoption and otherwise look unchanged.
      lastObservedSignal = baseline;
      lastExpectedAttemptId = expected;
    }
    const raw = await readOptionalReviewFixSignal(vars, signalPath);
    assertNativeReviewOperationCurrent();
    if (raw && raw !== lastObservedSignal) {
      lastObservedSignal = raw;
      try {
        const parsed: unknown = JSON.parse(raw);
        const normalized = normalizeWorkerSignal(parsed);
        const observed = normalized.ok ? normalized.signal : undefined;
        // A direct wait owns the changed file boundary and accepts its new attempt id.
        // Recovery waits are stricter: match the persisted id, or accept an id-less
        // legacy signal only while no id has been adopted by the durable context.
        const attemptMatches =
          typeof expectedAttemptId === 'function'
            ? expected
              ? observed?.attemptId === expected
              : !observed?.attemptId
            : !expected || observed?.attemptId === expected;
        if (attemptMatches) lastProgressAt = Date.now();
        const signal = observed ? terminalWorkerSignalFromRaw(raw) : undefined;
        if (signal && attemptMatches) return signal;
      } catch (err) {
        console.warn(`[review] failed to parse ${signalPath}: ${(err as Error).message}`);
      }
    }
    if (turnActive && Date.now() >= nextTurnStateCheckAt) {
      nextTurnStateCheckAt = Date.now() + turnStatePollMs;
      if (await turnActive()) lastProgressAt = Date.now();
    }
  }
  onTimeout?.(lastExpectedAttemptId);
  return undefined;
}
