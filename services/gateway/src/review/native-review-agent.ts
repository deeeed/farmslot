import { createHash, randomUUID } from 'node:crypto';

import {
  allocateReviewerContext,
  isTerminalRunStatus,
  type ReviewMode,
  type ReviewValidationDepth,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import { stackPrBase } from '../run-engine/stack-base.js';
import { validateNativeRunner } from '../runners/native/manager.js';
import { nativeReviewerOwner, nativeReviewerResultSchema } from '../runners/native/review-owner.js';
import { cancelNativeWorkerContext, dispatchNativeWorker } from '../runners/native/worker.js';
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { runnerDefaultSafetyTier } from '../runners/registry.js';
import {
  clearRunActiveTaskFile,
  getAllRuns,
  getRun,
  persistRunNow,
  updateRun,
} from '../runs/store.js';
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
import {
  capturePipelineVisualInput,
  collectPipelineVisualResult,
  pipelineVisualReviewPrompt,
} from './pipeline-visual-review.js';
import { startProgressWatcher } from './progress.js';
import {
  applyTerminalReviewSignal,
  continuationReviewScope,
  persistReviewOutputArtifacts,
  prependReviewerExecutionContract,
  readTerminalReviewSignal,
  type ReviewAgentResult,
  reviewChecklistMarkPrompt,
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  reviewerResultRelPath,
  scopeReviewFeedbackPath,
} from './review-agent.js';
import { admitReviewRound, reviewRoundAdmissionId } from './review-round-budget.js';
import { noteReviewInputsAtLaunch } from './reviewed-inputs.js';
import {
  claimWarmReviewerSession,
  invalidateWarmReviewerSessions,
  registerWarmReviewerSession,
  resolveWarmReviewerSession,
  reviewPRIdentity,
  type WarmReviewerScope,
  WarmReviewRefusal,
} from './session-mode.js';
import {
  captureReviewSnapshot,
  durationBetween,
  readPersistedReviewSnapshot,
  removeSlotFiles,
  reviewArtifactDir,
} from './snapshots.js';
import { expandReviewTemplate } from './templates.js';
import {
  isTerminalReviewArtifactError,
  nativeReviewerFailure,
  ReviewerExitedError,
  reviewerExitForNativeSnapshot,
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
  mode: ReviewMode;
  reviewId?: string | null;
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
  if (!original) throw new Error('Native review run not found');
  assertNativeRunOwner(original);
  validateNativeRunner(runner, model);
  const ownerPrincipalId = nativeReviewerOwner(original, vars);
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
  const contextPrefix = `${allocated.id}-native-${key}`;
  let context = [...(original.agentContexts ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.id.startsWith(contextPrefix) &&
        ['launching', 'working', 'waiting'].includes(candidate.status),
    );
  const contextId = context?.id ?? `${contextPrefix}-${randomUUID().slice(0, 8)}`;
  const recovering = Boolean(context?.nativeSession);
  const identity = reviewPRIdentity(original);
  const lineage =
    input.reviewId?.trim() || (input.mode === 'cold' ? artifactScope?.trim() || contextId : null);
  if (!lineage)
    throw new WarmReviewRefusal(
      'missing-session',
      'WARM requires the reviewId of the lineage being continued',
    );
  const scope: WarmReviewerScope = {
    reviewId: lineage,
    project: original.project,
    ownerPrincipalId,
    transport: 'native',
    runId,
    taskDir,
    artifactScope: artifactScope ?? null,
    runner,
    model,
    effort: input.effort?.trim() || null,
    repository: identity?.repository ?? '',
    prNumber: identity?.prNumber ?? 0,
  };
  let retained = null as ReturnType<typeof claimWarmReviewerSession>;
  let warmRunId: string | undefined;
  let warm: NonNullable<typeof original.agentContexts>[number] | undefined;
  if (input.mode === 'warm' && !recovering) {
    if (!identity)
      throw new WarmReviewRefusal('pr-mismatch', 'the current run has no verified repository/PR');
    retained = resolveWarmReviewerSession(scope, getAllRuns());
    if (!retained)
      throw new WarmReviewRefusal(
        'missing-session',
        'no verified previous PR reviewer is retained',
      );
    const sourceRun = getRun(retained.runId);
    warmRunId = retained.runId;
    warm = sourceRun?.agentContexts?.find((candidate) => candidate.id === retained!.contextId);
    if (
      !sourceRun ||
      warm?.nativeSession?.ownerPrincipalId !== ownerPrincipalId ||
      !warm?.nativeSession ||
      warm.role !== 'review' ||
      warm.nativeSession.releasedAt ||
      warm.nativeSession.recovery
    )
      throw new WarmReviewRefusal(
        'session-unavailable',
        'the retained native reviewer has no owned reusable session',
      );
    if (retained.slotId !== vars.slotId)
      throw new WarmReviewRefusal(
        'slot-mismatch',
        'the retained reviewer belongs to a different slot',
      );
    if (
      getAllRuns().some((run) =>
        run.agentContexts?.some(
          (candidate) =>
            candidate.runnerSessionId === retained!.runnerSessionId &&
            ['launching', 'working', 'waiting'].includes(candidate.status),
        ),
      )
    )
      throw new WarmReviewRefusal('session-busy', 'the retained reviewer is active');
  }
  const target = targetForChecklistBasename(reviewerChecklistBasename(contextId));
  const feedbackRelPath = reviewerFeedbackRelPath(contextId);
  const resultRelPath = reviewerResultRelPath(contextId);
  const taskMdPath = taskDirRelPath(taskDir, target.checklist);
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  const startedAt = recovering
    ? (context!.attemptStartedAt ?? context!.startedAt ?? new Date().toISOString())
    : new Date().toISOString();
  let resultSchema = context?.nativeSession?.resultSchema;
  let progress: { stop(): void | Promise<void> } | undefined;
  let activeTaskSet = false;
  let primaryFailure: unknown;
  try {
    const reviewSnapshot = await withNativeReviewMutation(async () => {
      admit();
      const snapshot = recovering
        ? await readPersistedReviewSnapshot(vars, taskDir, loopNumber, artifactScope)
        : await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope, {
            mode: input.mode,
            baseRef: (await stackPrBase(original)) ?? original.repeatReviewContext?.baseRef,
            lastReviewedHeadSha: retained?.lastReviewedHeadSha,
          });
      if (
        !snapshot?.snapshot.baseSha ||
        !snapshot.snapshot.headSha ||
        snapshot.snapshot.source === 'unavailable'
      )
        throw new Error('Native reviewer requires immutable captured base/head commits');
      const visualInput = recovering
        ? context?.pipelineVisualReviewInput
        : nativeReviewerResultSchema(vars, runner)
          ? await capturePipelineVisualInput(runId, snapshot.snapshot.headSha)
          : undefined;
      if (!recovering)
        resultSchema = visualInput ? nativeReviewerResultSchema(vars, runner) : undefined;
      if (retained && warm?.nativeSession?.resultSchema !== resultSchema)
        throw new WarmReviewRefusal(
          'session-unavailable',
          'the retained reviewer uses another result contract; choose cold',
        );
      await admitReviewRound(runId, reviewRoundAdmissionId(lineage, loopNumber, startedAt));
      if (retained) retained = claimWarmReviewerSession(scope, { consume: true });
      if (!recovering) {
        admit();
        context = (await upsertAgentContext(runId, 'review', {
          id: contextId,
          reviewId: lineage,
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
          ...(visualInput ? { pipelineVisualReviewInput: visualInput } : {}),
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
        const mark = reviewChecklistMarkPrompt(
          taskDir,
          taskMdPath,
          target,
          feedbackRelPath,
          resultRelPath,
        );
        let template = scopeReviewFeedbackPath(
          await expandReviewTemplate(vars, taskDir, runId, validationDepth, {
            ...target,
            feedback: feedbackRelPath,
          }),
          feedbackRelPath,
          resultRelPath,
        );
        // What this document gives the reviewer; a pass records it (F42).
        await noteReviewInputsAtLaunch(runId);
        template = retained
          ? continuationReviewScope({
              priorHeadSha: retained.lastReviewedHeadSha,
              currentHeadSha: snapshot.snapshot.headSha,
              priorArtifactDir: `${retained.taskDir}/${reviewArtifactDir(retained.lastLoopNumber, retained.artifactScope)}`,
            }) + template
          : `## COLD review range\n\nReview the complete PR diff ${snapshot.snapshot.baseSha}..${snapshot.snapshot.headSha} in ${taskDir}/${snapshot.snapshot.diffPath}.\n\n` +
            template;
        admit();
        await writeTextFileOnSlot(
          vars,
          taskMdPath,
          prependReviewerExecutionContract(template, mark) +
            (visualInput ? pipelineVisualReviewPrompt(visualInput, taskDir) : ''),
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
        syncChecklistTargetForRole(vars, taskDir, 'review', {
          reportPath: feedbackRelPath,
          additionalArtifactPaths: [resultRelPath],
          target,
        }),
      );
      if (recovering && context?.nativeSession?.generation) {
        const pendingRecovery = context.nativeSession.recovery;
        const snapshot = pendingRecovery
          ? null
          : await readNativeWorkerSnapshot(runId, 'review', contextId);
        if (pendingRecovery || snapshot?.session.processStopped) {
          admit();
          await resumeNativeWorker(runId, {
            purpose: 'review',
            contextId,
            assertCurrent: admit,
            text:
              reviewChecklistMarkPrompt(
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
        context?.nativeSession?.handoffFrom ??
        (warm ? { runId: warmRunId!, contextId: warm.id } : undefined);
      await dispatchNativeWorker({
        runId,
        vars,
        role: 'review',
        contextId,
        allowOperatorWait: true,
        assertCurrent: admit,
        retainedFrom: source,
        taskFile: taskMdPath,
        signalFile: taskDirRelPath(taskDir, target.signal),
        taskId: run.ticketOrPr,
        runner,
        model,
        resultSchema,
        effort: input.effort?.trim() || undefined,
        safetyTier: run.safetyTier ?? runnerDefaultSafetyTier(runner),
        project: projectVars.projectJson,
        projectVars,
        domain: resolveEffectiveDomain(run.domain, vars.domain),
        initialPrompt:
          reviewChecklistMarkPrompt(taskDir, taskMdPath, target, feedbackRelPath, resultRelPath) +
          '\nRead the reviewer-specific execution contract. Do NOT run /review.',
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
      role: 'review',
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
      const snapshot = await readNativeWorkerSnapshot(runId, 'review', contextId);
      const command = snapshot.commands.find(
        (command) => command.commandId === context!.nativeSession!.commandId,
      );
      const probe = await probeWorkerSignalForRun(runId, vars.slotId, context);
      if (probe.ok && command?.state === 'completed' && command.outcome === 'completed') break;
      if (!probe.ok && probe.code === 'artifact_contract')
        throw new TerminalReviewArtifactError(probe.message);
      if (['closed', 'failed'].includes(snapshot.session.state) || command?.outcome === 'failed') {
        const reason =
          snapshot.session.error ?? 'Native reviewer stopped without a valid terminal signal';
        throw reviewerExitForNativeSnapshot(snapshot) ?? new Error(reason);
      }
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
    const visualResult = !feedback.incomplete
      ? collectPipelineVisualResult(
          admit(),
          context,
          await readNativeWorkerSnapshot(runId, 'review', contextId),
        )
      : undefined;
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
        'review',
        {
          id: contextId,
          status: feedback.incomplete ? 'blocked' : 'complete',
          lastSignalAt: completedAt,
          reviewResultValidatedAt: feedback.incomplete ? undefined : completedAt,
          ...(visualResult ? { pipelineVisualReviewResult: visualResult } : {}),
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

    if (retained && context.runnerSessionId !== retained.runnerSessionId)
      throw new WarmReviewRefusal(
        'session-unavailable',
        'native delivery did not preserve the retained reviewer identity',
      );
    if (!feedback.incomplete && identity && context.runnerSessionId)
      registerWarmReviewerSession({
        ...scope,
        contextId,
        windowName: contextId,
        slotId: vars.slotId,
        runnerSessionId: context.runnerSessionId,
        runnerSessionPath: null,
        lastLoopNumber: loopNumber,
        lastReviewedHeadSha: reviewSnapshot.snapshot.headSha!,
      });
    const artifactPaths = [...reviewSnapshot.artifactPaths, ...persisted.artifactPaths];
    return {
      ...feedback,
      validationDepth,
      mode: input.mode,
      reviewId: lineage,
      reviewerSessionId: context.runnerSessionId,
      session: {
        mode: input.mode,
        reviewId: lineage,
        continuity: input.mode === 'warm' ? 'resumed' : 'fresh',
        ...(retained
          ? { priorRunId: retained.runId, priorSessionId: retained.runnerSessionId }
          : input.mode === 'warm' && recovering
            ? { priorRunId: runId, priorSessionId: context.runnerSessionId ?? undefined }
            : {}),
        sessionId: context.runnerSessionId ?? undefined,
        repository: identity?.repository,
        prNumber: identity?.prNumber,
        lastReviewedHeadSha:
          input.mode === 'warm'
            ? reviewSnapshot.snapshot.baseSha!
            : reviewSnapshot.snapshot.headSha!,
        runner,
        model,
        effort: input.effort?.trim() || null,
      },
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
    context =
      getRun(runId)?.agentContexts?.find((candidate) => candidate.id === contextId) ?? context;
    const failure = await nativeReviewerFailure(error, async () => {
      admit();
      return readNativeWorkerSnapshot(runId, 'review', contextId);
    });
    primaryFailure = failure;
    invalidateWarmReviewerSessions(runId, runner);
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
            'review',
            isTerminalReviewArtifactError(failure) ? 'blocked' : 'failed',
            { id: contextId },
          ),
        );
      } catch (recordError) {
        primaryFailure = new AggregateError(
          [failure, recordError],
          `${String(failure)}; reviewer status recording also failed: ${String(recordError)}`,
          { cause: failure },
        );
      }
    }
    throw primaryFailure;
  } finally {
    await finishReviewCleanup(primaryFailure, [
      () => progress?.stop(),
      () => unwatchContext(vars.slotId, contextId, { expectedRunId: runId }),
      async () => {
        if (!(primaryFailure instanceof ReviewerExitedError) || !context?.nativeSession) return;
        await withNativeReviewMutation(async () => {
          admit();
          await cancelNativeWorkerContext(runId, context!);
        });
      },
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
