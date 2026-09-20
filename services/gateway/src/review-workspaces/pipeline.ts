import { setTimeout as delay } from 'node:timers/promises';

import {
  Events,
  parseGitHubRef,
  PipelineSteps,
  type ReviewWorkspaceSubject,
  type Run,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import { fetchGitHubPR } from '../external/github.js';
import { isNodeTransportUnavailableError } from '../fleet/node-rpc.js';
import {
  buildRepeatReviewContext,
  findLatestPriorReviewRun,
} from '../run-engine/engine-decisions.js';
import { BlockedRunError } from '../run-engine/errors.js';
import { resolveMonitorConfig } from '../run-engine/run-monitor.js';
import {
  cancelReviewWorkspaceWorker,
  launchReviewWorkspaceWorker,
  readReviewWorkspaceWorker,
} from '../runners/native/review-workspace.js';
import {
  launchReviewTmux,
  recoverReviewTmuxSession,
  reviewTmuxOperation,
} from '../runners/review-tmux.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../runs/store.js';
import { withSubtaskMetrics } from '../tasks/subtask-metrics.js';

import { assertReviewWorkspaceAdmitted, inspectReviewWorkspaceTarget } from './admission.js';
import { compatibleWorkspaceReviewer, configureWorkspaceContinuity } from './continuity.js';
import { holdWorkspaceReview, waitingAtReviewGate } from './gate.js';
import { createReviewWorkspaceProgressPublisher } from './progress.js';
import { ensureReviewWorkspaceSupport } from './support.js';
import {
  collectReviewWorkspaceSubtaskMetrics,
  materializeReviewWorkspaceTask,
  readReviewWorkspaceCompletion,
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
 * The run's child-unit roll-up (ADR-060) for `run.metrics.subtasks`, or null when
 * it cannot be read.
 *
 * A corrupt registry must not lose the review's own metrics, which are the run's
 * primary cost record. Error level, not warn: child durations are missing from
 * the retrospective for this run and nothing downstream would say why. The same
 * read throws to its caller in `task.progress`, where the operator sees it on the
 * next progress request.
 */
async function reviewWorkspaceSubtaskMetrics(runId: string) {
  try {
    return await collectReviewWorkspaceSubtaskMetrics(runId);
  } catch (error) {
    console.error(
      `[review-workspace] subtask metrics unavailable for ${runId.slice(0, 8)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
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
  const prior = findLatestPriorReviewRun(
    run,
    getAllRuns().filter((candidate) => candidate.createdByPrincipalId === run.createdByPrincipalId),
  );
  const context = prior
    ? buildRepeatReviewContext(
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
      )
    : undefined;
  if (context && prior) {
    const resumeRequested =
      (run.prWork?.review?.options.sessionIntent ??
        (run.reviewScope === 'incremental' ? 'resume' : 'reset')) === 'resume';
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
      ...(context ? { repeatReviewContext: context, reviewScope: context.reviewScope } : {}),
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

/** Resource-specific step execution under the existing run engine and terminal router. */
export async function executeReviewWorkspaceStep(
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
      if (run.transport === 'tmux') {
        const started = await launchReviewTmux(runId, task.prompt, () =>
          admittedRun(runId, generation),
        );
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
      });
      return {
        outputs: {
          sessionId: snapshot.session.id,
          generation: snapshot.session.generation,
          slotId: null,
        },
      };
    }
    case PipelineSteps.MONITOR: {
      await ensureReviewWorkspaceSupport(runId, check);
      check();
      const project = await loadProjectVars(run.project);
      const config = resolveMonitorConfig(project.projectJson.monitoring, run.project, 'review-pr');
      const started =
        run.steps.find((entry) => entry.name === PipelineSteps.MONITOR)?.startedAt ??
        new Date().toISOString();
      const deadline = Date.parse(started) + config.totalTimeoutMs;
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
          const completion = await readReviewWorkspaceCompletion(runId);
          check();
          if (completion) {
            if (!completion.result || completion.signal.outcome !== 'success')
              throw new BlockedRunError(
                completion.signal.reason ?? 'Review did not complete',
                'review-incomplete',
              );
            await persistRunNow(
              updateRun(runId, {
                reviewResult: completion.result,
                metrics: withSubtaskMetrics(
                  currentWorkspaceRun(runId, generation).metrics,
                  await reviewWorkspaceSubtaskMetrics(runId),
                ),
              }),
              'workspace review result',
            );
            emit(Events.RUN_UPDATED, { run: getRun(runId) });
            return {
              outputs: {
                workerSignal: completion.signal,
                headSha: run.reviewWorkspaceSubject?.headSha,
              },
            };
          }
          const state = await reviewTmuxOperation(
            currentWorkspaceRun(runId, generation),
            'inspect',
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
            ? await readReviewWorkspaceCompletion(runId)
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
          await persistRunNow(
            updateRun(runId, {
              reviewResult: completion.result,
              metrics: withSubtaskMetrics(
                currentWorkspaceRun(runId, generation).metrics,
                await reviewWorkspaceSubtaskMetrics(runId),
              ),
            }),
            'workspace review result',
          );
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
