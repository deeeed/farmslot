import { setTimeout as delay } from 'node:timers/promises';

import {
  Events,
  parseGitHubRef,
  PipelineSteps,
  type ReviewWorkspaceSubject,
  type Run,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars } from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import { fetchGitHubPR } from '../external/github.js';
import { isNodeTransportUnavailableError } from '../fleet/node-rpc.js';
import {
  admitReviewRound,
  clearReviewRoundSettlement,
  reviewRoundAdmissionId,
  settleReviewRoundNoVerdict,
} from '../review/review-round-budget.js';
import { isUncertainReviewerOperation } from '../review/terminal-result.js';
import {
  buildRepeatReviewContext,
  confirmIncrementalAncestry,
  findLatestPriorReviewRun,
} from '../run-engine/engine-decisions.js';
import { BlockedRunError } from '../run-engine/errors.js';
import { resolveMonitorConfig } from '../run-engine/run-monitor.js';
import {
  cancelReviewWorkspaceWorker,
  launchReviewWorkspaceWorker,
  observeReviewWorkspaceTransport,
  readReviewWorkspaceWorker,
} from '../runners/native/review-workspace.js';
import { observeReviewPromptAcceptance } from '../runners/review-startup.js';
import {
  launchReviewTmux,
  recoverReviewTmuxSession,
  reviewTmuxOperation,
  reviewTmuxStartupState,
} from '../runners/review-tmux.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../runs/store.js';
import { runPrincipalOwner, samePrincipalOwner } from '../security/work-originator.js';
import { withSubtaskMetrics } from '../tasks/subtask-metrics.js';

import { preflightReviewWorkspaceAccount } from './account-preflight.js';
import { assertReviewWorkspaceAdmitted, inspectReviewWorkspaceTarget } from './admission.js';
import { compatibleWorkspaceReviewer, configureWorkspaceContinuity } from './continuity.js';
import { holdWorkspaceReview, waitingAtReviewGate } from './gate.js';
import { createReviewWorkspaceProgressPublisher } from './progress.js';
import { ensureReviewWorkspaceSupport } from './support.js';
import {
  collectReviewWorkspaceSubtaskMetrics,
  materializeReviewWorkspaceTask,
  readReviewWorkspaceCompletion,
  readReviewWorkspaceSignal,
} from './task.js';
import {
  allocateReviewWorkspace,
  cancelReviewWorkspaceAllocation,
  cleanupReviewWorkspace,
} from './workspace.js';

/** Repository-cache contention is a wait, not a failed review or permission to steal a lock. */
async function waitForWorkspaceOperation<T>(
  operation: () => Promise<T>,
  check: () => void,
): Promise<T> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    check();
    try {
      return await operation();
    } catch (error) {
      if (
        !(
          (error instanceof GatewayMethodError &&
            error.code === 'REVIEW_WORKSPACE_OPERATION_PENDING') ||
          isNodeTransportUnavailableError(error)
        ) ||
        Date.now() >= deadline
      )
        throw error;
      await delay(250);
    }
  }
}

function workspaceGenerationOwner(
  runId: string,
  generation: number,
  allowTerminal: boolean,
): Run | null {
  const run = getRun(runId);
  if (
    !run ||
    run.flowType !== 'review-pr' ||
    !run.reviewWorkspaceTarget ||
    run.slotId !== null ||
    (run.engineState?.generation ?? 0) !== generation ||
    (!allowTerminal && ['paused', 'blocked', 'done', 'cancelled', 'failed'].includes(run.status))
  ) {
    return null;
  }
  return run;
}

export function currentWorkspaceRun(runId: string, generation: number, allowTerminal = false): Run {
  const run = workspaceGenerationOwner(runId, generation, allowTerminal);
  if (!run) throw new Error('Review workspace execution no longer owns this run generation');
  return run;
}

/**
 * The same ownership test as {@link currentWorkspaceRun}, as a predicate. Used by
 * observability that must fall silent when its generation is superseded instead
 * of failing the step that replaced it.
 */
export function ownsWorkspaceGeneration(runId: string, generation: number): boolean {
  return workspaceGenerationOwner(runId, generation, false) !== null;
}

/**
 * Persist a settled static review: its typed result and the child-unit roll-up
 * (ADR-060) on `run.metrics.subtasks`.
 *
 * ONE recording path for both worker transports. The tmux and native monitor
 * branches read completion differently — a tmux pane is polled for its signal, a
 * native session for its command receipt — but what they record is identical, and
 * a second copy is how one transport quietly stops recording child metrics.
 *
 * A roll-up that cannot be read must not lose the review's own metrics, which are
 * the run's primary cost record, so it is reported and dropped. Error level, not
 * warn: child durations are then missing from the retrospective for this run and
 * nothing downstream would say why. The same read throws to its caller in
 * `task.progress`, where the operator sees it on the next progress request.
 */
export async function recordWorkspaceReviewCompletion(
  runId: string,
  generation: number,
  reviewResult: NonNullable<Run['reviewResult']>,
  deps: { collectSubtasks?: typeof collectReviewWorkspaceSubtaskMetrics } = {},
): Promise<Run> {
  const collectSubtasks = deps.collectSubtasks ?? collectReviewWorkspaceSubtaskMetrics;
  let subtasks: Awaited<ReturnType<typeof collectReviewWorkspaceSubtaskMetrics>> = null;
  try {
    subtasks = await collectSubtasks(runId);
  } catch (error) {
    console.error(
      `[review-workspace] subtask metrics unavailable for ${runId.slice(0, 8)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const updated = updateRun(runId, {
    reviewResult,
    metrics: withSubtaskMetrics(currentWorkspaceRun(runId, generation).metrics, subtasks),
  });
  await persistRunNow(updated, 'workspace review result');
  // A monitor replay watches the same attempt; its verdict counts even if the
  // superseded monitor settled that receipt (ADR-063 Amendment 2).
  await clearReviewRoundSettlement(runId, monitoredWorkspaceReviewRoundId(updated, generation));
  return updated;
}

async function admittedRun(runId: string, generation: number) {
  const run = currentWorkspaceRun(runId, generation);
  if (!run.nativeOwnerPrincipalId || !run.metrics.runner || !run.metrics.model) {
    throw new Error('Workspace review requires a recorded native owner, runner and model');
  }
  const admission = await inspectReviewWorkspaceTarget(
    {
      project: run.project,
      machine: run.reviewWorkspaceTarget!.machine,
      runner: run.metrics.runner,
      model: run.metrics.model,
      effort: run.effort,
      transport: run.transport,
      nativeProfile: run.nativeProfile,
    },
    run.nativeOwnerPrincipalId,
    runId,
  );
  currentWorkspaceRun(runId, generation);
  assertReviewWorkspaceAdmitted(admission, runId);
  return admission;
}

/** Freeze provider facts once. Later retries never silently move the review to another head. */
async function freezeSubject(
  runId: string,
  generation: number,
  repositoryUrl: string,
): Promise<ReviewWorkspaceSubject> {
  const run = currentWorkspaceRun(runId, generation);
  if (run.reviewWorkspaceSubject) return run.reviewWorkspaceSubject;
  const reference = parseGitHubRef(run.ticketOrPr);
  if (!reference) throw new Error('Workspace review requires a canonical PR reference');
  const pr = await fetchGitHubPR(run.ticketOrPr);
  currentWorkspaceRun(runId, generation);
  if (pr.number !== reference.number)
    throw new Error('PR metadata belongs to another review target');
  if (!/^[a-f0-9]{40}$/i.test(pr.headSha) || !/^[a-f0-9]{40}$/i.test(pr.baseSha)) {
    throw new Error('PR metadata did not contain exact commit identities');
  }
  if (run.prWork && run.prWork.headSha !== pr.headSha) {
    throw new BlockedRunError(
      'PR head changed after admission; refresh the review request',
      'review-head-changed',
    );
  }
  const subject: ReviewWorkspaceSubject = {
    repository: reference.repo,
    repositoryUrl,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    branch: pr.branch,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    capturedAt: new Date().toISOString(),
  };
  const owner = runPrincipalOwner(run);
  const prior = findLatestPriorReviewRun(
    run,
    getAllRuns().filter((candidate) => {
      const candidateOwner = runPrincipalOwner(candidate);
      return owner && candidateOwner && samePrincipalOwner(owner, candidateOwner);
    }),
  );
  const context = prior
    ? await confirmIncrementalAncestry(
        buildRepeatReviewContext(
          run,
          prior,
          {
            project: run.project,
            repository: reference.repo,
            prNumber: reference.number,
            headSha: pr.headSha,
            baseRef: pr.baseRef,
          },
          getAllRuns(),
        ),
      )
    : undefined;
  currentWorkspaceRun(runId, generation);
  if (!prior && resolveReviewMode({ run }) === 'warm')
    throw new Error('WARM review unavailable: no previous review for this repository/PR');
  if (context && prior) {
    const resumeRequested = resolveReviewMode({ run }) === 'warm';
    if (resumeRequested && compatibleWorkspaceReviewer(run, prior)) {
      // Fill only the missing session identity on the saved prior run; its result stays immutable.
      await recoverReviewTmuxSession(prior, () => {
        currentWorkspaceRun(runId, generation);
      });
    }
    const savedPrior = getRun(prior.id);
    if (!savedPrior) throw new Error('The prior review was removed during session recovery');
    configureWorkspaceContinuity(run, savedPrior, context);
  }
  await persistRunNow(
    updateRun(runId, {
      reviewWorkspaceSubject: subject,
      branch: pr.branch,
      summary: pr.title,
      ...(context ? { repeatReviewContext: context, reviewMode: context.mode } : {}),
    }),
    'freeze workspace review subject',
  );
  return subject;
}

export async function teardownReviewWorkspace(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.reviewWorkspace) return;
  const generation = run.engineState?.generation ?? 0;
  if (run.transport === 'tmux') {
    if (run.agentContexts?.some((c) => c.target)) await reviewTmuxOperation(run, 'stop');
  } else await cancelReviewWorkspaceWorker(runId);
  if (run.reviewWorkspace.cleanedAt) return;
  const check = () => {
    currentWorkspaceRun(runId, generation, true);
  };
  if (run.status === 'cancelled')
    await cancelReviewWorkspaceAllocation(runId, { assertCurrent: check });
  await waitForWorkspaceOperation(
    () => cleanupReviewWorkspace(runId, { assertCurrent: check }),
    check,
  );
  const current = currentWorkspaceRun(runId, generation, true);
  await persistRunNow(
    updateRun(runId, {
      reviewWorkspace: { ...current.reviewWorkspace!, cleanedAt: new Date().toISOString() },
      reviewWorkspaceCleanupError: undefined,
    }),
    'workspace checkout cleaned',
  );
}

function hasHeldReviewWorker(run: Run): boolean {
  return (
    run.agentContexts?.some(
      (context) =>
        context.nativeSession &&
        !context.nativeSession.closedAt &&
        !context.nativeSession.releasedAt,
    ) ?? false
  );
}

function hasUncertainReviewOperation(run: Run): boolean {
  return (
    run.status === 'blocked' &&
    run.steps.some(
      (step) => step.status === 'failed' && Boolean(step.outputs?.nativeWorkerOperationUncertain),
    )
  );
}

/** A startup timeout ends observation, not ownership of the admitted reviewer. */
export function workspaceReviewStartupNeedsRecovery(run: Run): boolean {
  return (
    run.flowType === 'review-pr' &&
    run.transport === 'tmux' &&
    Boolean(run.reviewWorkspaceTarget && run.reviewWorkspace && !run.reviewWorkspace.cleanedAt) &&
    ['reconciling', 'reviewing', 'blocked'].includes(run.status) &&
    !run.decisions.some((decision) => !decision.resolvedAt) &&
    run.steps.some((step) => step.name === PipelineSteps.DISPATCH && step.status === 'done') &&
    run.steps.some(
      (step) =>
        step.name === PipelineSteps.MONITOR &&
        step.status === 'done' &&
        step.detail === 'review-startup-unacknowledged',
    ) &&
    [PipelineSteps.HUMAN_GATE, PipelineSteps.COMPLETE].every(
      (name) => run.steps.find((step) => step.name === name)?.status === 'skipped',
    ) &&
    Boolean(
      run.agentContexts?.some(
        (context) =>
          context.id === 'review' && context.target?.session && context.promptDeliveryStartedAt,
      ),
    )
  );
}

let startupRecoveryInProgress: Promise<void> | undefined;

function canRecoverWorkspaceReviewStartup(run: Run): boolean {
  return (
    workspaceReviewStartupNeedsRecovery(run) &&
    run.autoRecoveryDisabled !== true &&
    !['disabled', 'manual-in-progress'].includes(run.recoveryProposal?.status ?? '')
  );
}

/** Reattach observation to the original attempt, never replay dispatch or send a prompt. */
export function reconcileReviewWorkspaceStartup(
  emit: (event: string, payload: unknown) => void,
  resumeRun: (runId: string) => void,
): Promise<void> {
  if (startupRecoveryInProgress) return startupRecoveryInProgress;
  startupRecoveryInProgress = (async () => {
    for (const observed of getAllRuns()
      .filter(canRecoverWorkspaceReviewStartup)
      .map((run) => structuredClone(run))) {
      const generation = observed.engineState?.generation ?? 0;
      const context = observed.agentContexts!.find((entry) => entry.id === 'review')!;
      const stillCurrent = () => {
        const current = getRun(observed.id);
        const candidate = current?.agentContexts?.find((entry) => entry.id === 'review');
        return (
          current &&
          canRecoverWorkspaceReviewStartup(current) &&
          (current.engineState?.generation ?? 0) === generation &&
          current.reviewWorkspace?.workspaceId === observed.reviewWorkspace?.workspaceId &&
          candidate?.promptDeliveryStartedAt === context.promptDeliveryStartedAt &&
          candidate?.signalAttemptId === context.signalAttemptId &&
          candidate?.target?.session === context.target?.session
        );
      };
      let acknowledged: boolean;
      try {
        const signal = await readReviewWorkspaceSignal(observed.id);
        if (!stillCurrent()) continue;
        acknowledged = Boolean(signal || (await observeReviewPromptAcceptance(observed)));
      } catch (error) {
        // One node can be unavailable while other reviewers finish. Keep this
        // attempt pending, expose its observation failure, and visit the others.
        if (!stillCurrent()) continue;
        const message = `Reviewer startup recovery is waiting: ${error instanceof Error ? error.message : String(error)}`;
        if (getRun(observed.id)?.error !== message) {
          await persistRunNow(
            updateRun(observed.id, { error: message }),
            'reviewer startup observation unavailable',
          );
          emit(Events.RUN_UPDATED, { run: getRun(observed.id) });
        }
        continue;
      }
      if (!acknowledged || !stillCurrent()) continue;
      // The timeout refunded this admission. Late execution consumes that same round.
      await clearReviewRoundSettlement(
        observed.id,
        monitoredWorkspaceReviewRoundId(observed, generation),
      );
      if (!stillCurrent()) continue;
      const current = getRun(observed.id)!;
      await persistRunNow(
        updateRun(current.id, {
          status: 'monitoring',
          error: undefined,
          completedAt: undefined,
          metrics: { ...current.metrics, outcome: undefined },
          steps: current.steps.map((step) =>
            step.name === PipelineSteps.MONITOR ||
            ((step.name === PipelineSteps.HUMAN_GATE || step.name === PipelineSteps.COMPLETE) &&
              step.status === 'skipped')
              ? { ...step, status: 'pending', detail: undefined, completedAt: undefined }
              : step,
          ),
        }),
        'late reviewer startup acknowledged',
      );
      emit(Events.RUN_UPDATED, { run: getRun(current.id) });
      resumeRun(current.id);
    }
  })().finally(() => {
    startupRecoveryInProgress = undefined;
  });
  return startupRecoveryInProgress;
}

let cleanupInProgress: Promise<void> | undefined;

/** Reconcile interrupted terminal cleanup independently of active-run recovery. */
export function reconcileReviewWorkspaceCleanup(
  emit: (event: string, payload: unknown) => void,
): Promise<void> {
  if (cleanupInProgress) return cleanupInProgress;
  cleanupInProgress = (async () => {
    for (const run of getAllRuns()) {
      if (
        !run.reviewWorkspace ||
        (run.reviewWorkspace.cleanedAt && !hasHeldReviewWorker(run)) ||
        hasUncertainReviewOperation(run) ||
        workspaceReviewStartupNeedsRecovery(run) ||
        waitingAtReviewGate(run) ||
        !['done', 'failed', 'cancelled', 'blocked'].includes(run.status)
      )
        continue;
      try {
        await teardownReviewWorkspace(run.id);
        if (getRun(run.id)?.reviewWorkspaceCleanupError) {
          await persistRunNow(
            updateRun(run.id, { reviewWorkspaceCleanupError: undefined }),
            'workspace cleanup recovered',
          );
          emit(Events.RUN_UPDATED, { run: getRun(run.id) });
        }
      } catch (error) {
        // Retain a visible retryable cleanup failure. Never release an uncertain process's capacity.
        const message = error instanceof Error ? error.message : String(error);
        if (getRun(run.id)?.reviewWorkspaceCleanupError !== message) {
          await persistRunNow(
            updateRun(run.id, { reviewWorkspaceCleanupError: message }),
            'workspace cleanup pending',
          );
          emit(Events.RUN_UPDATED, { run: getRun(run.id) });
        }
      }
    }
  })().finally(() => {
    cleanupInProgress = undefined;
  });
  return cleanupInProgress;
}

/**
 * A workspace review attempt's receipt, keyed by the engine generation its
 * DISPATCH ran at. A restart re-enters DISPATCH at the same generation and
 * reuses it; a replay that dispatches again runs at a new generation. Generation
 * 0 keeps the receipt runs admitted before attempts were told apart.
 */
function workspaceReviewRoundId(
  run: Pick<Run, 'id' | 'createdAt'>,
  dispatchGeneration: number,
): string {
  return reviewRoundAdmissionId(
    `workspace-review-${run.id}`,
    dispatchGeneration + 1,
    run.createdAt,
  );
}

/** The attempt a monitor watches: the one its DISPATCH admitted, even after a monitor-only replay. */
function monitoredWorkspaceReviewRoundId(
  run: Pick<Run, 'id' | 'createdAt' | 'engineState'>,
  generation: number,
): string {
  return workspaceReviewRoundId(
    run,
    run.engineState?.workspaceReviewDispatchGeneration ?? generation,
  );
}

/** Resource-specific step execution under the existing run engine and terminal router. */
export async function executeReviewWorkspaceStep(
  runId: string,
  step: string,
  generation: number,
  emit: (event: string, payload: unknown) => void,
): Promise<{ inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }> {
  const before = getRun(runId);
  const resultBefore = before?.reviewResult;
  // Resolve the attempt now: a replay that supersedes this monitor may dispatch again.
  const roundId = before && monitoredWorkspaceReviewRoundId(before, generation);
  try {
    return await executeOwnedReviewWorkspaceStep(runId, step, generation, emit);
  } catch (error) {
    // A monitor that ends without recording the reviewer's result is a no-verdict
    // end, a cancel or supersession included (ADR-063 Amendment 2). An uncertain
    // native operation may still be running its reviewer, so its round counts.
    const run = getRun(runId);
    if (
      run &&
      roundId &&
      step === PipelineSteps.MONITOR &&
      run.reviewResult === resultBefore &&
      !isUncertainReviewerOperation(error)
    )
      await settleReviewRoundNoVerdict(
        runId,
        roundId,
        error instanceof BlockedRunError
          ? error.detail
          : error instanceof Error
            ? error.message
            : String(error),
      );
    throw error;
  }
}

async function executeOwnedReviewWorkspaceStep(
  runId: string,
  step: string,
  generation: number,
  emit: (event: string, payload: unknown) => void,
): Promise<{ inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }> {
  const check = () => {
    currentWorkspaceRun(runId, generation);
  };
  let run = currentWorkspaceRun(runId, generation);
  switch (step) {
    case PipelineSteps.FIND_SLOT: {
      const admission = await admittedRun(runId, generation);
      const subject = await freezeSubject(runId, generation, admission.project.repoUrl);
      const workspace = await waitForWorkspaceOperation(
        () =>
          allocateReviewWorkspace(runId, admission, {
            ...subject,
            assertCurrent: check,
          }),
        check,
      );
      check();
      return {
        inputs: { machine: admission.pool.machine, headSha: subject.headSha },
        outputs: { workspace, slotId: null },
      };
    }
    case PipelineSteps.WRITE_TASK: {
      if (!run.reviewWorkspaceSubject) throw new Error('Workspace review subject is missing');
      await preflightReviewWorkspaceAccount(run, check);
      await ensureReviewWorkspaceSupport(runId, check);
      check();
      const task = await materializeReviewWorkspaceTask(runId, run.reviewWorkspaceSubject);
      check();
      await persistRunNow(
        updateRun(runId, { taskFile: task.taskFile }),
        'workspace review task path',
      );
      return { outputs: { taskFile: task.taskFile, template: getRun(runId)?.executionTemplate } };
    }
    case PipelineSteps.PREPARE:
      return { outputs: { skipped: true, reason: 'static-review-workspace', appPrepared: false } };
    case PipelineSteps.DISPATCH: {
      if (!run.reviewWorkspaceSubject) throw new Error('Workspace review subject is missing');
      await ensureReviewWorkspaceSupport(runId, check);
      check();
      const task = await materializeReviewWorkspaceTask(runId, run.reviewWorkspaceSubject);
      const project = await loadProjectVars(run.project);
      check();
      const config = resolveMonitorConfig(project.projectJson.monitoring, run.project, 'review-pr');
      const started =
        run.steps.find((entry) => entry.name === PipelineSteps.DISPATCH)?.startedAt ??
        new Date().toISOString();
      const roundId = workspaceReviewRoundId(run, generation);
      await admitReviewRound(runId, roundId);
      if (getRun(runId)?.engineState?.workspaceReviewDispatchGeneration !== generation) {
        const admitted = currentWorkspaceRun(runId, generation);
        await persistRunNow(
          updateRun(runId, {
            engineState: { ...admitted.engineState, workspaceReviewDispatchGeneration: generation },
          }),
          'workspace review round',
        );
      }
      // A failed launch is a no-verdict end. One that may have started its
      // reviewer is reconciled later, so its round still counts.
      const settleFailedLaunch = async (error: unknown): Promise<never> => {
        if (!isUncertainReviewerOperation(error))
          await settleReviewRoundNoVerdict(
            runId,
            roundId,
            error instanceof Error ? error.message : String(error),
          );
        throw error;
      };
      if (run.transport === 'tmux') {
        const started = await launchReviewTmux(runId, task.prompt, () =>
          admittedRun(runId, generation),
        ).catch(settleFailedLaunch);
        return { outputs: { ...started, slotId: null, transport: 'tmux' } };
      }
      const snapshot = await launchReviewWorkspaceWorker({
        runId,
        project: project.projectJson,
        domain: run.domain,
        prompt: task.prompt,
        deadline: Date.parse(started) + config.totalTimeoutMs,
        assertCurrent: async () => {
          await admittedRun(runId, generation);
        },
      }).catch(settleFailedLaunch);
      return {
        outputs: {
          sessionId: snapshot.session.id,
          generation: snapshot.session.generation,
          slotId: null,
        },
      };
    }
    case PipelineSteps.MONITOR: {
      if (run.reviewWorkspace?.cleanedAt) {
        // Recovery of a completed report needs its frozen task and artifacts,
        // not a checkout, skill installation or a new reviewer process.
        const completion = await observeReviewWorkspaceTransport(
          () => readReviewWorkspaceCompletion(runId),
          check,
          Date.now() + 300_000,
          'observation',
        );
        check();
        if (!completion?.result || completion.signal.outcome !== 'success')
          throw new BlockedRunError(
            'No complete saved review is available. Start a new review.',
            'review-incomplete',
          );
        await recordWorkspaceReviewCompletion(runId, generation, completion.result);
        emit(Events.RUN_UPDATED, { run: getRun(runId) });
        return {
          outputs: {
            workerSignal: completion.signal,
            headSha: run.reviewWorkspaceSubject?.headSha,
            recovered: true,
          },
        };
      }
      const project = await loadProjectVars(run.project);
      const config = resolveMonitorConfig(project.projectJson.monitoring, run.project, 'review-pr');
      const started =
        run.steps.find((entry) => entry.name === PipelineSteps.MONITOR)?.startedAt ??
        new Date().toISOString();
      const deadline = Date.parse(started) + config.totalTimeoutMs;
      // Restart recovery can enter before the owning execution node reconnects.
      // All monitor reads share the journal's retry/fencing rules and deadline.
      const observe = <T>(operation: () => Promise<T>) =>
        observeReviewWorkspaceTransport(operation, check, deadline, 'observation');
      await observe(() => ensureReviewWorkspaceSupport(runId, check));
      check();
      // Live checklist, child-unit (ADR-060) and acceptance-ledger progress for a
      // run that has no slot, and with it the view refresh that keeps the
      // operator-visible mirror current. The publisher throttles its own reads and
      // falls silent once this generation stops owning the run, so the loop
      // exiting is its whole teardown.
      const progress = createReviewWorkspaceProgressPublisher(runId, emit, {
        isCurrent: () => ownsWorkspaceGeneration(runId, generation),
      });
      while (Date.now() < deadline) {
        check();
        await progress.publish();
        check();
        if (run.transport === 'tmux') {
          const signal = await observe(() => readReviewWorkspaceSignal(runId));
          check();
          const current = currentWorkspaceRun(runId, generation);
          const context = current.agentContexts?.find((entry) => entry.id === 'review');
          const acceptance = await observe(() => observeReviewPromptAcceptance(current));
          check();
          const startup = reviewTmuxStartupState(signal, acceptance, {
            startedAt: context?.promptDeliveryStartedAt ?? started,
            now: Date.now(),
          });
          if (startup === 'blocked')
            throw new BlockedRunError(
              'Reviewer has not acknowledged its task. Check its terminal for a startup prompt, sign-in or usage limit. This run will resume when the original reviewer starts or finishes.',
              'review-startup-unacknowledged',
            );
          const status = startup === 'acknowledged' ? 'working' : 'launching';
          if (
            context &&
            (context.status !== status ||
              (signal?.attemptId !== undefined && context.signalAttemptId !== signal.attemptId) ||
              (acceptance &&
                (!context.promptAcceptance ||
                  context.promptAcceptance.deliveryStartedAt !== acceptance.deliveryStartedAt ||
                  context.promptAcceptance.sessionId !== acceptance.sessionId ||
                  context.promptAcceptance.runner !== acceptance.runner)))
          ) {
            await upsertAgentContext(
              runId,
              'review',
              { id: 'review' },
              {
                resolvePatch: () => {
                  check();
                  return {
                    id: 'review',
                    status,
                    ...(signal?.attemptId ? { signalAttemptId: signal.attemptId } : {}),
                    ...(acceptance
                      ? {
                          promptAcceptance: acceptance,
                          runnerSessionId: acceptance.sessionId,
                          runnerSessionPath: acceptance.sessionPath,
                          runnerSessionCapturedAt: new Date(acceptance.observedAt).toISOString(),
                        }
                      : {}),
                  };
                },
              },
            );
            await persistRunNow(getRun(runId)!, 'reviewer startup acknowledgment');
            emit(Events.RUN_UPDATED, { run: getRun(runId) });
          }
          const completion = await observe(() => readReviewWorkspaceCompletion(runId));
          check();
          if (completion) {
            if (
              !completion.result ||
              (completion.signal.outcome !== 'success' && completion.signal.status !== 'blocked')
            )
              throw new BlockedRunError(
                completion.signal.reason ?? 'Review did not complete',
                'review-incomplete',
              );
            const partialReason =
              completion.signal.status === 'blocked'
                ? `Review found ${completion.result.lineComments.length} issue(s), but the required comparison evidence was not available. The report and line comments are ready for the publication decision.`
                : undefined;
            if (partialReason) {
              await persistRunNow(
                updateRun(runId, { error: partialReason }),
                'review findings ready',
              );
            }
            await recordWorkspaceReviewCompletion(runId, generation, completion.result);
            emit(Events.RUN_UPDATED, { run: getRun(runId) });
            return {
              outputs: {
                workerSignal: completion.signal,
                headSha: run.reviewWorkspaceSubject?.headSha,
                ...(completion.signal.status === 'blocked' ? { partial: true } : {}),
              },
            };
          }
          const state = await observe(() =>
            reviewTmuxOperation(currentWorkspaceRun(runId, generation), 'inspect'),
          );
          check();
          if (!state.exists)
            throw new BlockedRunError(
              'Reviewer exited before completing its review',
              'review-worker-stopped',
            );
          await delay(1000);
          continue;
        }
        const snapshot = await readReviewWorkspaceWorker(runId, { deadline });
        check();
        run = currentWorkspaceRun(runId, generation);
        const binding = run.agentContexts?.find(
          (context) => context.id === 'review',
        )?.nativeSession;
        const command = snapshot.commands.find((entry) => entry.commandId === binding?.commandId);
        const completion =
          command?.accepted && command.outcome === 'completed'
            ? await observe(() => readReviewWorkspaceCompletion(runId))
            : null;
        check();
        if (completion && command?.accepted && command.outcome === 'completed') {
          if (
            !completion.result ||
            !['complete', 'done'].includes(completion.signal.status) ||
            completion.signal.outcome !== 'success'
          ) {
            throw new BlockedRunError(
              completion.signal.reason ?? 'Reviewer did not complete the static review',
              'review-incomplete',
            );
          }
          await recordWorkspaceReviewCompletion(runId, generation, completion.result);
          emit(Events.RUN_UPDATED, { run: getRun(runId) });
          return {
            outputs: {
              workerSignal: completion.signal,
              headSha: run.reviewWorkspaceSubject?.headSha,
              nativeCommandId: command.commandId,
            },
          };
        }
        if (
          command?.outcome === 'failed' ||
          command?.outcome === 'interrupted' ||
          ['closed', 'failed'].includes(snapshot.session.state)
        ) {
          throw new BlockedRunError(
            'Reviewer stopped before producing a valid result for the frozen head',
            'review-worker-stopped',
          );
        }
        if (command?.outcome === 'completed' && !completion) {
          throw new BlockedRunError(
            'Reviewer finished its turn without a complete review result',
            'review-result-missing',
          );
        }
        await delay(1000);
      }
      throw new BlockedRunError(
        'Static review exceeded the configured monitoring timeout',
        'review-timeout',
      );
    }
    case PipelineSteps.HUMAN_GATE:
      return { outputs: await holdWorkspaceReview(runId) };
    case PipelineSteps.COMPLETE:
      if (!run.reviewResult)
        throw new Error('Cannot complete a workspace review without its result');
      await teardownReviewWorkspace(runId);
      return { outputs: { headSha: run.reviewWorkspaceSubject?.headSha, artifactsRetained: true } };
    default:
      throw new Error(`Unsupported workspace review step: ${step}`);
  }
}
