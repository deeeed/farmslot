import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  allocateReviewerContext,
  isTerminalRunStatus,
  type ReviewSessionIntent,
  type ReviewValidationDepth,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import { cancelNativeWorkerContext, dispatchNativeWorker } from '../runners/native/worker.js';
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { runnerDefaultSafetyTier } from '../runners/registry.js';
import { clearRunActiveTaskFile, getRun, persistRunNow, updateRun } from '../runs/store.js';
import { unavailableRunnerSessionUsage } from '../runtime/session-usage.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';
import {
  restoreWorkerChecklistTargetFromSlot,
  syncChecklistTargetForRole,
  targetForChecklistBasename,
  taskDirRelPath,
} from '../tasks/checklist-target.js';
import { unwatchContext } from '../tasks/watcher.js';

import { finishReviewCleanup } from './cleanup.js';
import { readReviewFeedback } from './feedback.js';
import {
  assertNativeReviewOperationCurrent,
  captureNativeReviewOperationCheck,
  nativeReviewOperationIsCurrent,
  withNativeReviewMutation,
  withNativeReviewOperation,
} from './native-review-operation.js';
import { startProgressWatcher } from './progress.js';
import {
  applyTerminalReviewSignal,
  continuationReviewScope,
  persistReviewOutputArtifacts,
  prependReviewerExecutionContract,
  readTerminalReviewSignal,
  reReviewChecklistPrefix,
  type ReviewAgentResult,
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  reviewerResultRelPath,
  scopeReviewFeedbackPath,
  selfReviewChecklistMarkPrompt,
} from './review-agent.js';
import type { ReviewSessionPolicy } from './session-policy.js';
import {
  captureReviewSnapshot,
  durationBetween,
  readPersistedReviewSnapshot,
  removeSlotFiles,
  reviewArtifactDir,
} from './snapshots.js';
import { expandSelfReviewTemplate } from './templates.js';
import {
  isTerminalReviewArtifactError,
  TerminalReviewArtifactError,
  terminalReviewArtifactErrorForCompletion,
} from './terminal-result.js';

type NativeReviewInput = {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  runner: string;
  model: string;
  taskDir: string;
  runId: string;
  reviewTimeoutMs: number;
  loopNumber: number;
  validationDepth: ReviewValidationDepth;
  artifactScope?: string | null;
  sessionPolicy: ReviewSessionPolicy;
  sessionIntent: ReviewSessionIntent;
  effort?: string | null;
};

export async function runNativeReviewAgent(input: NativeReviewInput): Promise<ReviewAgentResult> {
  const run = getRun(input.runId);
  if (!run) throw new Error('Native review run not found');
  return withNativeReviewOperation(run, () => runOwnedNativeReviewAgent(input));
}

async function runOwnedNativeReviewAgent(input: NativeReviewInput): Promise<ReviewAgentResult> {
  const { vars, runId, runner, model, taskDir, loopNumber, artifactScope, validationDepth } = input;
  const original = getRun(runId);
  if (!original || original.transport !== 'native') throw new Error('Native review run not found');
  assertNativeRunOwner(original);
  const generation = original.engineState?.generation ?? 0;
  const admit = () => {
    assertNativeReviewOperationCurrent();
    const run = getRun(runId);
    if (
      !run ||
      isTerminalRunStatus(run.status) ||
      run.slotId !== vars.slotId ||
      (run.engineState?.generation ?? 0) !== generation
    )
      throw new Error('Native review was superseded by another run action');
    assertNativeRunOwner(run);
    return run;
  };
  admit();
  const allocated = allocateReviewerContext({ runId, runner, model });
  const key = createHash('sha256')
    .update(JSON.stringify([generation, taskDir, artifactScope ?? null, loopNumber, model]))
    .digest('hex')
    .slice(0, 12);
  const contextId = `${allocated.id}-native-${key}`;
  let context = original.agentContexts?.find((context) => context.id === contextId);
  const recovering = Boolean(context?.nativeSession);
  const prior = [...(original.agentContexts ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.id !== contextId &&
        candidate.role === 'self-review' &&
        candidate.runner === runner &&
        candidate.model === model &&
        candidate.nativeSession &&
        !candidate.nativeSession.closedAt &&
        !candidate.nativeSession.releasedAt &&
        candidate.taskFile &&
        path.posix.dirname(candidate.taskFile) === taskDir &&
        (candidate.artifactScope === (artifactScope ?? null) ||
          (input.sessionIntent === 'resume' && loopNumber === 1)),
    );
  const warm =
    prior &&
    prior.status === 'complete' &&
    prior.reviewResultValidatedAt &&
    (input.sessionIntent === 'resume' ||
      (input.sessionPolicy === 'warm-per-reviewer' && loopNumber > 1))
      ? prior
      : undefined;
  const target = targetForChecklistBasename(reviewerChecklistBasename(contextId));
  const feedbackRelPath = reviewerFeedbackRelPath(contextId);
  const resultRelPath = reviewerResultRelPath(contextId);
  const taskMdPath = taskDirRelPath(taskDir, target.checklist);
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const startedAt = recovering
    ? (context!.attemptStartedAt ?? context!.startedAt ?? new Date().toISOString())
    : new Date().toISOString();
  let progress: { stop(): void | Promise<void> } | undefined;
  let activeTaskSet = false;
  let primaryFailure: unknown;
  try {
    const reviewSnapshot = await withNativeReviewMutation(async () => {
      admit();
      const snapshot = recovering
        ? await readPersistedReviewSnapshot(vars, taskDir, loopNumber, artifactScope)
        : await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope);
      if (!snapshot) throw new Error('Native reviewer snapshot is unavailable for recovery');
      if (!recovering) {
        if (prior && !warm) await cancelNativeWorkerContext(runId, prior);
        admit();
        context = (await upsertAgentContext(runId, 'self-review', {
          id: contextId,
          label: allocated.label,
          status: 'launching',
          attemptStartedAt: startedAt,
          taskFile: taskMdPath,
          signalFile: taskDirRelPath(taskDir, target.signal),
          reviewResultFile: resultRelPath,
          artifactScope: artifactScope ?? null,
          reviewLoopNumber: loopNumber,
          runner,
          model,
          ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
          target: null,
        }))!;
        await removeSlotFiles(
          vars,
          [feedbackRelPath, resultRelPath, target.signal].map(
            (file) => `${vars.remoteRepo}/${taskDir}/${file}`,
          ),
        );
        admit();
        const mark = selfReviewChecklistMarkPrompt(
          taskDir,
          taskMdPath,
          target,
          feedbackRelPath,
          resultRelPath,
        );
        let template = scopeReviewFeedbackPath(
          await expandSelfReviewTemplate(vars, taskDir, runId, validationDepth),
          feedbackRelPath,
          resultRelPath,
        );
        if (loopNumber > 1) {
          const previous = await readPersistedReviewSnapshot(
            vars,
            taskDir,
            loopNumber - 1,
            artifactScope,
          );
          const prefix = reReviewChecklistPrefix({
            taskDir,
            loopNumber,
            artifactScope,
            priorHeadSha: previous?.snapshot.headSha ?? null,
            currentHeadSha: snapshot.snapshot.headSha ?? null,
          });
          if (prefix) template = `${prefix}${template}`;
        } else if (warm) {
          const previous = await readPersistedReviewSnapshot(
            vars,
            taskDir,
            warm.reviewLoopNumber ?? 1,
            warm.artifactScope,
          );
          template =
            continuationReviewScope({
              priorHeadSha: previous?.snapshot.headSha ?? null,
              currentHeadSha: snapshot.snapshot.headSha ?? null,
              priorArtifactDir: `${taskDir}/${reviewArtifactDir(warm.reviewLoopNumber ?? 1, warm.artifactScope)}`,
            }) + template;
        }
        admit();
        await writeTextFileOnSlot(
          vars,
          taskMdPath,
          prependReviewerExecutionContract(template, mark),
        );
      }
      admit();
      updateRun(runId, { activeTaskFile: taskMdPath });
      activeTaskSet = true;
      return snapshot;
    });
    const run = admit();
    const existingTerminal = recovering
      ? await probeWorkerSignalForRun(runId, vars.slotId, context!)
      : null;
    if (existingTerminal && !existingTerminal.ok && existingTerminal.code === 'artifact_contract')
      throw new TerminalReviewArtifactError(existingTerminal.message);
    if (!existingTerminal?.ok) {
      await withNativeReviewMutation(() =>
        syncChecklistTargetForRole(vars, taskDir, 'self-review', {
          reportPath: feedbackRelPath,
          additionalArtifactPaths: [resultRelPath],
          target,
        }),
      );
      if (recovering && context?.nativeSession?.generation) {
        const pendingRecovery = context.nativeSession.recovery;
        const snapshot = pendingRecovery
          ? null
          : await readNativeWorkerSnapshot(runId, 'self-review', contextId);
        if (pendingRecovery || snapshot?.session.processStopped) {
          admit();
          await resumeNativeWorker(runId, {
            purpose: 'self-review',
            contextId,
            assertCurrent: admit,
            text:
              selfReviewChecklistMarkPrompt(
                taskDir,
                taskMdPath,
                target,
                feedbackRelPath,
                resultRelPath,
              ) +
              '\nContinue this reviewer attempt and preserve completed work. Read its reviewer-specific execution contract. Do NOT run /review.',
          });
        }
      }
      const projectVars = await loadProjectVars(run.project);
      const source =
        context?.nativeSession?.handoffFrom ?? (warm ? { runId, contextId: warm.id } : undefined);
      await dispatchNativeWorker({
        runId,
        vars,
        role: 'self-review',
        contextId,
        allowOperatorWait: true,
        assertCurrent: admit,
        retainedFrom: source,
        taskFile: taskMdPath,
        signalFile: taskDirRelPath(taskDir, target.signal),
        taskId: run.ticketOrPr,
        runner,
        model,
        effort: input.effort?.trim() || run.effort,
        safetyTier: run.safetyTier ?? runnerDefaultSafetyTier(runner),
        project: projectVars.projectJson,
        projectVars,
        domain: resolveEffectiveDomain(run.domain, vars.domain),
        initialPrompt:
          selfReviewChecklistMarkPrompt(
            taskDir,
            taskMdPath,
            target,
            feedbackRelPath,
            resultRelPath,
          ) + '\nRead the reviewer-specific execution contract. Do NOT run /review.',
        beforeInput: async () => {
          const current = admit();
          const { enforceDispatchPressureGate } = await import('../methods/dispatch/execute.js');
          await enforceDispatchPressureGate({
            machine: vars.machine,
            runId,
            run: current,
            attemptKey: `native-review:${runId}:${contextId}`,
            deps: {
              persistRun: async (id, patch) => {
                await persistRunNow(updateRun(id, patch), 'native reviewer pressure admission');
              },
            },
          });
        },
        emit: () => {},
      });
    }
    context = getRun(runId)!.agentContexts!.find((candidate) => candidate.id === contextId)!;
    const reviewBinding = context.nativeSession!;
    progress = startProgressWatcher(vars, `${vars.remoteRepo}/${taskMdPath}`, runId, 'Review', {
      contextId,
      role: 'self-review',
      isCurrent: captureNativeReviewOperationCheck(),
    });
    const deadline = Date.now() + input.reviewTimeoutMs;
    while (true) {
      const latest = admit().agentContexts?.find((candidate) => candidate.id === contextId);
      if (
        !latest ||
        latest.nativeSession?.releasedAt ||
        latest.nativeSession?.sessionId !== reviewBinding.sessionId ||
        latest.nativeSession.leaseId !== reviewBinding.leaseId ||
        latest.nativeSession.generation !== reviewBinding.generation ||
        latest.taskFile !== taskMdPath
      )
        throw new Error('Native reviewer context changed during completion monitoring');
      // A resumed process can bootstrap a fresh signal attempt. Read the watcher's
      // current binding so its valid terminal signal is not compared with the old one.
      context = latest;
      const probe = await probeWorkerSignalForRun(runId, vars.slotId, context);
      if (probe.ok) break;
      if (probe.code === 'artifact_contract') throw new TerminalReviewArtifactError(probe.message);
      const snapshot = await readNativeWorkerSnapshot(runId, 'self-review', contextId);
      const command = snapshot.commands.find(
        (command) => command.commandId === context!.nativeSession!.commandId,
      );
      if (['closed', 'failed'].includes(snapshot.session.state) || command?.outcome === 'failed')
        throw new Error('Native reviewer stopped without a valid terminal signal');
      if (Date.now() >= deadline) {
        await cancelNativeWorkerContext(runId, context);
        throw new Error(`Native reviewer did not complete within ${input.reviewTimeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    admit();
    const terminal = await readTerminalReviewSignal(vars, taskDir, target.signal);
    const feedback = applyTerminalReviewSignal(
      await readReviewFeedback(vars, taskDir, feedbackRelPath, resultRelPath),
      terminal,
    );
    const error = terminalReviewArtifactErrorForCompletion(
      contextId,
      feedback.terminalInvalidReason,
    );
    if (error) throw error;
    const persisted = await withNativeReviewMutation(() =>
      persistReviewOutputArtifacts({
        vars,
        taskDir,
        taskMdPath,
        signalBasename: target.signal,
        feedbackRelPath,
        resultRelPath,
        artifactDir,
        feedbackIncomplete: feedback.incomplete ?? false,
      }),
    );
    const completedAt = new Date().toISOString();
    admit();
    await withNativeReviewMutation(() =>
      upsertAgentContext(
        runId,
        'self-review',
        {
          id: contextId,
          status: feedback.incomplete ? 'blocked' : 'complete',
          lastSignalAt: completedAt,
          reviewResultValidatedAt: feedback.incomplete ? undefined : completedAt,
        },
        {
          guard: async () => {
            admit();
            return true;
          },
          mirrorIf: (slot) => slot.current_run_id === runId,
        },
      ),
    );
    await persistRunNow(getRun(runId)!, 'native reviewer result validated');

    const artifactPaths = [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths];
    return {
      ...feedback,
      validationDepth,
      reviewSnapshot: reviewSnapshot.snapshot,
      usage: unavailableRunnerSessionUsage({
        runner,
        runnerSessionId: context.runnerSessionId ?? null,
        runnerSessionPath: null,
        error: 'Native reviewer usage accounting is unavailable',
      }),
      artifactPaths,
      taskProgressArtifactPath: persisted.taskProgressArtifactPath,
      startedAt,
      completedAt,
      timeline: [
        {
          kind: loopNumber > 1 ? 're-review' : 'review',
          loopNumber,
          runner,
          model,
          startedAt,
          completedAt,
          durationMs: durationBetween(startedAt, completedAt),
          verdict: feedback.verdict,
          unresolvedCount: feedback.verdict === 'pass' ? 0 : feedback.issues.length,
          artifactPaths,
        },
      ],
    };
  } catch (error) {
    primaryFailure = error;
    const run = getRun(runId);
    if (
      context &&
      run &&
      nativeReviewOperationIsCurrent() &&
      !isTerminalRunStatus(run.status) &&
      (run.engineState?.generation ?? 0) === generation
    ) {
      try {
        await withNativeReviewMutation(() =>
          markAgentContextStatus(
            runId,
            'self-review',
            isTerminalReviewArtifactError(error) ? 'blocked' : 'failed',
            { id: contextId },
          ),
        );
      } catch (recordError) {
        primaryFailure = new AggregateError(
          [error, recordError],
          `${String(error)}; reviewer status recording also failed: ${String(recordError)}`,
          { cause: error },
        );
      }
    }
    throw primaryFailure;
  } finally {
    await finishReviewCleanup(primaryFailure, [
      () => progress?.stop(),
      () => unwatchContext(vars.slotId, contextId, { expectedRunId: runId }),
      async () => {
        if (!activeTaskSet || !nativeReviewOperationIsCurrent()) return;
        await withNativeReviewMutation(async () => {
          const run = admit();
          if (run.activeTaskFile !== taskMdPath) return;
          clearRunActiveTaskFile(runId, taskMdPath);
          await restoreWorkerChecklistTargetFromSlot(vars, taskDir, {
            flowType: run.flowType,
            mode: run.mode,
          });
        });
      },
    ]);
  }
}
