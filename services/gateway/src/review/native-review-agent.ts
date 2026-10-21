import { randomUUID } from 'node:crypto';

import {
  allocateReviewerContext,
  isTerminalRunStatus,
  type ReviewMode,
  type ReviewSessionFallback,
  type ReviewValidationDepth,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import { markAgentContextStatus, upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';
import { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import { stackPrBase } from '../run-engine/stack-base.js';
import { validateNativeRunner } from '../runners/native/manager.js';
import { nativeReviewerOwner, nativeReviewerResultSchema } from '../runners/native/review-owner.js';
import { cancelNativeWorkerContext, dispatchNativeWorker } from '../runners/native/worker.js';
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import { NativeWorkerOperationUncertainError } from '../runners/native/worker-error.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { PromptDeliveryUncertainError, runnerDefaultSafetyTier } from '../runners/registry.js';
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
import { refuseReviewerApprovals } from './native-reviewer-approvals.js';
import {
  capturePipelineVisualInput,
  collectPipelineVisualResult,
  pipelineReviewResultSchema,
  pipelineVisualReviewPrompt,
} from './pipeline-visual-review.js';
import { startProgressWatcher } from './progress.js';
import {
  applyTerminalReviewSignal,
  continuationReviewScope,
  deltaFallbackReviewScope,
  isLiveNativeReviewer,
  nativeReviewerContextPrefix,
  persistReviewOutputArtifacts,
  prependReviewerExecutionContract,
  readTerminalReviewSignal,
  refundedNativeReviewer,
  type ReReviewContinuation,
  type ReviewAgentResult,
  reviewChecklistMarkPrompt,
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  reviewerResultRelPath,
  reviewerScratchRule,
  scopeReviewFeedbackPath,
} from './review-agent.js';
import {
  admitReviewRound,
  clearReviewRoundSettlement,
  reviewLaunchStartedAt,
  reviewRoundAdmissionId,
  settleReviewRoundNoVerdict,
} from './review-round-budget.js';
import { noteReviewInputsAtLaunch } from './reviewed-inputs.js';
import {
  claimWarmReviewerSession,
  invalidateWarmReviewerSessions,
  registerWarmReviewerSession,
  resolveWarmReviewerSession,
  reviewPRIdentity,
  usableRetainedReviewer,
  warmLineageScope,
  type WarmReviewerScope,
  WarmReviewRefusal,
} from './session-mode.js';
import {
  captureReviewDeltaSnapshot,
  captureReviewSnapshot,
  durationBetween,
  readPersistedReviewSnapshot,
  removeSlotFiles,
  reviewArtifactDir,
} from './snapshots.js';
import { expandReviewTemplate } from './templates.js';
import {
  isTerminalReviewArtifactError,
  isUncertainReviewerOperation,
  nativeReviewerFailure,
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
  /** An automatic re-review: an unavailable session runs the delta-scoped COLD fallback. */
  rereview?: ReReviewContinuation | null;
};

/** The retained reviewer's resume never started; the attempt continues as the fallback. */
class NativeReviewResumeFailure extends Error {
  override name = 'NativeReviewResumeFailure';
  constructor(
    readonly refusal: WarmReviewRefusal,
    readonly roundId: string,
    readonly contextId: string,
    /** The admitted attempt's launch time: its receipt and any reattach key on it. */
    readonly startedAt: string,
    options: ErrorOptions,
  ) {
    super(refusal.message, options);
  }
}

const WARM_BUSY_POLL_MS = 250;

// The completion loop refuses every approval the reviewer asks for (refuseReviewerApprovals).
const REFUSED_APPROVALS =
  '\nRunner actions that need approval are refused, never asked: do not retry them; continue the review from the code.';

/**
 * Stop a settled reviewer's process; its saved conversation stays resumable.
 *
 * WARM does not need the live process: a re-review transfers the stopped session
 * and resumes it (dispatchNativeWorker's handoff). A live idle reviewer only held
 * its process and MCP servers until the slot changed hands (TAT-4006 run 7721a02b's
 * reviewer outlived its result by five hours). The verdict is already recorded, so
 * an unconfirmed stop is reported, not raised: its binding stays held, and the next
 * reuse of the slot stops it (retireNativeWorkersForSlot).
 */
async function stopSettledReviewer(runId: string, contextId: string): Promise<void> {
  const context = getRun(runId)?.agentContexts?.find((candidate) => candidate.id === contextId);
  if (!context) return;
  try {
    await cancelNativeWorkerContext(runId, context);
  } catch (error) {
    console.warn(
      `[review] ${runId.slice(0, 8)}: settled reviewer ${contextId} did not confirm its stop: ${(error as Error).message}`,
    );
  }
}

export async function runNativeReviewAgent(input: NativeReviewInput): Promise<ReviewAgentResult> {
  const run = getRun(input.runId);
  if (!run) throw new Error('Native review run not found');
  return withNativeReviewOperation(run, () => runOwnedNativeReviewAgent(input));
}

async function runOwnedNativeReviewAgent(input: NativeReviewInput): Promise<ReviewAgentResult> {
  try {
    return await runNativeReviewAttempt(input);
  } catch (error) {
    if (
      !(error instanceof NativeReviewResumeFailure) ||
      getRun(input.runId)?.agentContexts?.some(
        (context) =>
          context.id === error.contextId &&
          ['launching', 'working', 'waiting'].includes(context.status),
      )
    )
      throw error;
    // ADR-063 Amendment 5: the same attempt runs the delta-scoped COLD under its receipt.
    return runNativeReviewAttempt(input, error);
  }
}

async function runNativeReviewAttempt(
  input: NativeReviewInput,
  resumeFailure?: Pick<NativeReviewResumeFailure, 'refusal' | 'roundId' | 'startedAt'>,
): Promise<ReviewAgentResult> {
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
  const contextPrefix = nativeReviewerContextPrefix({
    runId,
    runner,
    model,
    generation,
    taskDir,
    artifactScope,
    loopNumber,
  });
  let context =
    [...(original.agentContexts ?? [])]
      .reverse()
      .find((candidate) => isLiveNativeReviewer(candidate, contextPrefix)) ??
    refundedNativeReviewer(original, {
      runner,
      model,
      taskDir,
      artifactScope,
      reviewId: input.reviewId,
      effort: input.effort,
    });
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
    familyId: warmLineageScope(original),
    ...identity,
  };
  let retained = null as ReturnType<typeof claimWarmReviewerSession>;
  let warmRunId: string | undefined;
  let warm: NonNullable<typeof original.agentContexts>[number] | undefined;
  let fallback = resumeFailure?.refusal;
  // A person's WARM request shows the reason; an automatic re-review never stops on it.
  const fallBack = (refusal: WarmReviewRefusal) => {
    if (!input.rereview) throw refusal;
    fallback = refusal;
    retained = null;
    warm = undefined;
    warmRunId = undefined;
  };
  const resolveRetained = () => {
    const runs = getAllRuns();
    const session = resolveWarmReviewerSession(scope, runs);
    if (!session)
      throw new WarmReviewRefusal(
        'missing-session',
        'no verified previous reviewer of this lineage is retained',
      );
    const context = usableRetainedReviewer(
      session,
      { ownerPrincipalId, slotId: vars.slotId },
      runs,
    );
    return { session, context };
  };
  if (input.mode === 'warm' && !recovering && !fallback) {
    const deadline = Date.now() + input.reviewTimeoutMs;
    for (;;) {
      try {
        const found = resolveRetained();
        retained = found.session;
        warm = found.context;
        warmRunId = found.session.runId;
        break;
      } catch (error) {
        if (!(error instanceof WarmReviewRefusal)) throw error;
        // A busy session is not unavailable: the re-review waits for its current turn.
        if (error.reason !== 'session-busy' || Date.now() >= deadline) {
          fallBack(error);
          break;
        }
        admit();
        await new Promise((resolve) => setTimeout(resolve, WARM_BUSY_POLL_MS));
      }
    }
  }
  const target = targetForChecklistBasename(reviewerChecklistBasename(contextId));
  const feedbackRelPath = reviewerFeedbackRelPath(contextId);
  const resultRelPath = reviewerResultRelPath(contextId);
  const taskMdPath = taskDirRelPath(taskDir, target.checklist);
  const artifactDir = reviewArtifactDir(loopNumber, artifactScope);
  // A fallback keeps the failed resume's launch time, so a reattach names the admitted receipt.
  const startedAt = reviewLaunchStartedAt(context, resumeFailure?.startedAt);
  const roundId = resumeFailure?.roundId ?? reviewRoundAdmissionId(lineage, loopNumber, startedAt);
  let resultSchema = context?.nativeSession?.resultSchema;
  let progress: { stop(): void | Promise<void> } | undefined;
  let activeTaskSet = false;
  let primaryFailure: unknown;
  let fallbackRecord: ReviewSessionFallback | undefined;
  try {
    const reviewSnapshot = await withNativeReviewMutation(async () => {
      admit();
      const baseRef = (await stackPrBase(original)) ?? original.repeatReviewContext?.baseRef;
      if (
        retained &&
        (
          await execOnSlot(
            vars,
            `git merge-base --is-ancestor ${shellQuote(retained.lastReviewedHeadSha)} HEAD`,
            { timeout: 10_000 },
          )
        ).exitCode !== 0
      )
        fallBack(
          new WarmReviewRefusal(
            'reviewed-head-not-ancestor',
            'the current head no longer descends from the last reviewed head',
          ),
        );
      const delta =
        fallback && !recovering
          ? await captureReviewDeltaSnapshot(vars, taskDir, loopNumber, artifactScope, {
              lastReviewedHeadSha: input.rereview!.lastReviewedHeadSha,
              baseRef,
            })
          : undefined;
      let comparedRanges = delta?.comparedRanges;
      const snapshot = recovering
        ? await readPersistedReviewSnapshot(vars, taskDir, loopNumber, artifactScope)
        : (delta ??
          (await captureReviewSnapshot(vars, taskDir, loopNumber, artifactScope, {
            mode: input.mode,
            baseRef,
            lastReviewedHeadSha: retained?.lastReviewedHeadSha,
          })));
      if (
        !snapshot?.snapshot.baseSha ||
        !snapshot.snapshot.headSha ||
        snapshot.snapshot.source === 'unavailable'
      )
        throw new Error('Native reviewer requires immutable captured base/head commits');
      const range = { baseSha: snapshot.snapshot.baseSha, headSha: snapshot.snapshot.headSha };
      let visualInput = recovering
        ? context?.pipelineVisualReviewInput
        : nativeReviewerResultSchema(vars, runner)
          ? await capturePipelineVisualInput(
              runId,
              range,
              async (ancestor, head) =>
                (
                  await execOnSlot(
                    vars,
                    `git merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(head)}`,
                    { timeout: 10_000 },
                  )
                ).exitCode === 0,
            )
          : undefined;
      if (!recovering) {
        // A repair review needs its own result contract; without it there is no visual authority.
        resultSchema = visualInput
          ? nativeReviewerResultSchema(vars, runner, pipelineReviewResultSchema(visualInput))
          : undefined;
        if (!resultSchema) visualInput = undefined;
      }
      if (retained && warm?.nativeSession?.resultSchema !== resultSchema) {
        fallBack(
          new WarmReviewRefusal(
            'session-unavailable',
            'the retained reviewer uses another result contract; choose cold',
          ),
        );
        // The WARM range already captured is this lineage's delta.
        comparedRanges = [`${range.baseSha}..${range.headSha}`];
      }
      fallbackRecord = fallback
        ? { reason: fallback.reason, detail: fallback.detail, comparedRanges: comparedRanges ?? [] }
        : undefined;
      await admitReviewRound(runId, roundId);
      if (retained) retained = claimWarmReviewerSession(scope, { consume: true });
      if (!recovering) {
        admit();
        context = (await upsertAgentContext(runId, 'review', {
          id: contextId,
          reviewId: lineage,
          label: allocated.label,
          status: 'launching',
          startedAt,
          attemptStartedAt: startedAt,
          taskFile: taskMdPath,
          signalFile: taskDirRelPath(taskDir, target.signal),
          reviewResultFile: resultRelPath,
          artifactScope: artifactScope ?? null,
          reviewLoopNumber: loopNumber,
          ...(fallbackRecord ? { reviewFallback: fallbackRecord } : {}),
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
          : fallback
            ? deltaFallbackReviewScope({
                reason: fallback.detail,
                comparedRanges: comparedRanges!,
                rangeDiffPath: delta?.rangeDiffPath && `${taskDir}/${delta.rangeDiffPath}`,
                deltaUnavailable: delta?.deltaUnavailable,
                priorIssues: input.rereview!.priorIssues,
              }) + template
            : `## COLD review range\n\nReview the complete PR diff ${snapshot.snapshot.baseSha}..${snapshot.snapshot.headSha} in ${taskDir}/${snapshot.snapshot.diffPath}.\n\n` +
              template;
        admit();
        await writeTextFileOnSlot(
          vars,
          taskMdPath,
          prependReviewerExecutionContract(
            template,
            `${mark}\n\n${reviewerScratchRule(contextId)}`,
          ) + (visualInput ? pipelineVisualReviewPrompt(visualInput, taskDir) : ''),
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
              '\nContinue this reviewer attempt and preserve completed work. Read its reviewer-specific execution contract. Do NOT run /review.' +
              REFUSED_APPROVALS,
          });
        }
      }
      const projectVars = await loadProjectVars(run.project);
      const source =
        context?.nativeSession?.handoffFrom ??
        (warm ? { runId: warmRunId!, contextId: warm.id } : undefined);
      const dispatched = dispatchNativeWorker({
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
          '\nRead the reviewer-specific execution contract. Do NOT run /review.' +
          REFUSED_APPROVALS,
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
      try {
        await dispatched;
      } catch (error) {
        const current = getRun(runId);
        const accepted = current?.agentContexts?.find((candidate) => candidate.id === contextId)
          ?.nativeSession?.acceptedAt;
        // Only a resume that never started falls back: not a superseded attempt, and not a
        // delivery whose reviewer may still be running the prompt.
        if (
          !warm ||
          !input.rereview ||
          accepted ||
          !nativeReviewOperationIsCurrent() ||
          !current ||
          isTerminalRunStatus(current.status) ||
          (current.engineState?.generation ?? 0) !== generation ||
          error instanceof PromptDeliveryUncertainError ||
          (error instanceof NativeWorkerOperationUncertainError && error.operation === 'delivery')
        )
          throw error;
        throw new NativeReviewResumeFailure(
          new WarmReviewRefusal(
            'session-unavailable',
            `the retained reviewer could not resume: ${(error as Error).message}`,
          ),
          roundId,
          contextId,
          startedAt,
          { cause: error },
        );
      }
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
      const refused = await refuseReviewerApprovals(context.nativeSession!, snapshot);
      if (refused)
        console.warn(`[review] ${runId.slice(0, 8)}: refused ${refused} runner approval(s)`);
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
    if (feedback.incomplete) await settleReviewRoundNoVerdict(runId, roundId, 'no-feedback-file');
    else await clearReviewRoundSettlement(runId, roundId);
    await stopSettledReviewer(runId, contextId);

    if (retained && context.runnerSessionId !== retained.runnerSessionId)
      throw new WarmReviewRefusal(
        'session-unavailable',
        'native delivery did not preserve the retained reviewer identity',
      );
    // A fallback's fresh session becomes the lineage's retained session.
    if (!feedback.incomplete && context.runnerSessionId)
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
    // A fallback reattached after a restart reports the fallback its context recorded.
    const recordedFallback = fallbackRecord ?? context.reviewFallback;
    const mode: ReviewMode = recordedFallback ? 'cold' : input.mode;
    return {
      ...feedback,
      validationDepth,
      mode,
      reviewId: lineage,
      reviewerSessionId: context.runnerSessionId,
      session: {
        mode,
        reviewId: lineage,
        continuity: mode === 'warm' ? 'resumed' : 'fresh',
        ...(retained
          ? { priorRunId: retained.runId, priorSessionId: retained.runnerSessionId }
          : mode === 'warm' && recovering
            ? { priorRunId: runId, priorSessionId: context.runnerSessionId ?? undefined }
            : {}),
        sessionId: context.runnerSessionId ?? undefined,
        ...(identity ? { repository: identity.repository, prNumber: identity.prNumber } : {}),
        lastReviewedHeadSha:
          mode === 'warm' ? reviewSnapshot.snapshot.baseSha! : reviewSnapshot.snapshot.headSha!,
        runner,
        model,
        effort: input.effort?.trim() || null,
        ...(recordedFallback ? { fallback: recordedFallback } : {}),
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
    const failure =
      error instanceof NativeReviewResumeFailure
        ? error
        : await nativeReviewerFailure(error, async () => {
            admit();
            return readNativeWorkerSnapshot(runId, 'review', contextId);
          });
    primaryFailure = failure;
    invalidateWarmReviewerSessions(runId, runner, lineage);
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
    let stopped = true;
    if (
      !isUncertainReviewerOperation(failure) &&
      context?.nativeSession &&
      nativeReviewOperationIsCurrent() &&
      run &&
      !isTerminalRunStatus(run.status) &&
      (run.engineState?.generation ?? 0) === generation
    ) {
      try {
        await withNativeReviewMutation(async () => {
          admit();
          await cancelNativeWorkerContext(runId, context!);
        });
      } catch (stopError) {
        stopped = false;
        primaryFailure = new AggregateError(
          [primaryFailure, stopError],
          `${failure instanceof Error ? failure.message : String(failure)}; reviewer process cleanup is unconfirmed`,
          { cause: primaryFailure },
        );
      }
    }
    // Every end here is no-verdict, a superseded attempt included (ADR-063 Amendment 2).
    // An uncertain launch or delivery may still be running a reviewer; its round
    // counts until recovery settles it.
    try {
      // A resume that never started continues as the fallback under this receipt.
      if (
        stopped &&
        !isUncertainReviewerOperation(failure) &&
        !(failure instanceof NativeReviewResumeFailure)
      )
        await settleReviewRoundNoVerdict(
          runId,
          roundId,
          failure instanceof Error ? failure.message : String(failure),
        );
    } catch (settleError) {
      // An unsettled receipt still counts, which fails closed. The reviewer's own
      // failure keeps its type so relaunch and cleanup still recognize it.
      console.warn(
        `[review] ${runId.slice(0, 8)}: no-verdict settlement failed: ${String(settleError)}`,
      );
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
