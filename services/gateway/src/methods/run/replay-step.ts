import { randomUUID } from 'node:crypto';

import {
  DEFAULT_TASK_DIR,
  Events,
  FLOW_STEPS,
  isInteractiveDevRun,
  PipelineSteps as PS,
  type RunReplayStepParams,
  type RunReplayStepResult,
  type RunStatus,
} from '@farmslot/protocol';

import { execOnSlot } from '../../core/exec.js';
import { shellQuote } from '../../core/tmux.js';
import {
  bumpRunGeneration,
  cancelRunEngine,
  setRunFlags,
  startRun,
} from '../../run-engine/orchestrator.js';
import { getRun, updateRun, updateRunStep } from '../../runs/store.js';
import { validateTicketRef } from '../dispatch/ticket-ref.js';

import { isInternalArtifactOnlyEvalTicket, isLocalDevRef } from './ticket-policy.js';

type Emit = (event: string, payload: unknown) => void;

const REPLAY_STEP_TO_ACTIVE_STATUS: Partial<Record<string, RunStatus>> = {
  [PS.GRADE]: 'grading',
  [PS.WRITE_TASK]: 'writing-task',
  [PS.FIND_SLOT]: 'slot-finding',
  [PS.PREPARE]: 'preparing',
  [PS.DISPATCH]: 'dispatching',
  [PS.MONITOR]: 'monitoring',
  [PS.SELF_REVIEW]: 'self-reviewing',
  [PS.HUMAN_GATE]: 'human-gating',
  [PS.FINALIZE]: 'completing',
  [PS.COMPLETE]: 'completing',
  [PS.CI_WATCH]: 'ci-watching',
};

function activeStatusForReplayStep(stepName: string): RunStatus {
  return REPLAY_STEP_TO_ACTIVE_STATUS[stepName] ?? 'created';
}

function isQueuedPromptDispatchFalseNegative(
  existing: NonNullable<ReturnType<typeof getRun>>,
): boolean {
  const dispatchStep = existing.steps.find((candidate) => candidate.name === PS.DISPATCH);
  if (dispatchStep?.status !== 'failed') return false;
  const text = [dispatchStep.detail, existing.error].filter(Boolean).join('\n');
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  return (
    normalized.includes('messages to be submitted after next tool call') ||
    normalized.includes('submitted after next tool call')
  );
}

function repairQueuedPromptDispatchFalseNegative(runId: string): void {
  const current = getRun(runId);
  if (!current) return;
  const dispatchStep = current.steps.find((candidate) => candidate.name === PS.DISPATCH);
  if (!dispatchStep || dispatchStep.status !== 'failed') return;

  const repairedAt = new Date().toISOString();
  const durationMs = dispatchStep.startedAt
    ? Date.now() - new Date(dispatchStep.startedAt).getTime()
    : dispatchStep.durationMs;

  updateRunStep(runId, PS.DISPATCH, {
    status: 'done',
    completedAt: dispatchStep.completedAt ?? repairedAt,
    durationMs,
    detail: 'Prompt accepted: runner queued the task for submission after the next tool call.',
    outputs: {
      ...(dispatchStep.outputs ?? {}),
      promptDelivery: 'queued-after-next-tool-call',
      repairedAt,
    },
  });

  updateRun(runId, {
    agentContexts: (current.agentContexts ?? []).map((context) =>
      context.status === 'failed'
        ? {
            ...context,
            status: 'working',
            completedAt: undefined,
            lastSignalAt: repairedAt,
            updatedAt: repairedAt,
          }
        : context,
    ),
  });
}

export async function runReplayStep(
  params: RunReplayStepParams,
  emit: Emit,
): Promise<RunReplayStepResult> {
  if (
    params.triggeredBy !== undefined &&
    params.triggeredBy !== 'auto-recovery' &&
    params.triggeredBy !== 'operator'
  ) {
    throw new Error(`Invalid runReplayStep triggeredBy: ${String(params.triggeredBy)}`);
  }
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  const triggeredBy = params.triggeredBy ?? 'operator';

  // Pre-flight validation: if the stored ticketOrPr doesn't match the flow's expected
  // shape, retrying will hit the same error every time. Fail loudly at the entry so
  // the user understands the run is unrecoverable and needs to be recreated with a
  // correct reference (rather than seeing the same deep "write-task" error repeatedly).
  if (
    !isInternalArtifactOnlyEvalTicket(existing) &&
    !(isInteractiveDevRun(existing) && isLocalDevRef(existing.ticketOrPr))
  ) {
    try {
      validateTicketRef(existing.ticketOrPr, existing.flowType);
    } catch (err) {
      throw new Error(
        `Cannot replay run: ${(err as Error).message}. ` +
          `The stored ticketOrPr is invalid for this flow — delete this run and create a new one with a correct reference.`,
      );
    }
  }

  const flowSteps = FLOW_STEPS[existing.flowType];
  let replayStepName = params.stepName;
  let targetIdx = flowSteps ? flowSteps.indexOf(params.stepName as (typeof flowSteps)[number]) : -1;
  const findSlotIdx = flowSteps ? flowSteps.indexOf(PS.FIND_SLOT) : -1;
  const writeTaskIdx = flowSteps ? flowSteps.indexOf(PS.WRITE_TASK) : -1;
  const prepareIdx = flowSteps ? flowSteps.indexOf(PS.PREPARE) : -1;
  const monitorIdx = flowSteps ? flowSteps.indexOf(PS.MONITOR) : -1;
  const selfReviewIdx = flowSteps ? flowSteps.indexOf(PS.SELF_REVIEW) : -1;
  const completeIdx = flowSteps ? flowSteps.indexOf(PS.COMPLETE) : -1;
  const humanGateIdx = flowSteps ? flowSteps.indexOf(PS.HUMAN_GATE) : -1;
  if (
    existing.engineState?.evalExperiment &&
    targetIdx >= 0 &&
    prepareIdx >= 0 &&
    monitorIdx >= 0 &&
    targetIdx > prepareIdx &&
    targetIdx <= monitorIdx
  ) {
    replayStepName = PS.PREPARE;
    targetIdx = prepareIdx;
    console.log(
      `[run] replay from ${params.stepName} — starting at prepare so eval harness is reinstalled`,
    );
  }

  const step = existing.steps.find((s) => s.name === replayStepName);
  if (!step) throw new Error(`Step not found: ${params.stepName}`);

  if (replayStepName === PS.MONITOR && isQueuedPromptDispatchFalseNegative(existing)) {
    repairQueuedPromptDispatchFalseNegative(params.runId);
  }

  // Invalidate any in-flight engine loop so it bails instead of overwriting our state.
  // Do this only after replay entry validation so rejected replays do not leave a
  // synthetic in-progress recovery lane behind.
  cancelRunEngine(params.runId);
  bumpRunGeneration(params.runId);

  let replayTaskFile = existing.taskFile ?? null;

  if (targetIdx >= 0 && writeTaskIdx >= 0 && targetIdx > writeTaskIdx && !replayTaskFile) {
    const writeTaskStep = existing.steps.find((candidate) => candidate.name === PS.WRITE_TASK);
    const taskFile = writeTaskStep?.outputs?.taskFile;
    if (typeof taskFile === 'string' && taskFile.trim()) {
      replayTaskFile = taskFile;
      console.log(`[run] replay from ${replayStepName} — restored taskFile from write-task output`);
    }
  }

  // If replaying from find-slot or earlier, clear slot so it picks fresh
  if (targetIdx >= 0 && targetIdx <= findSlotIdx) {
    replayTaskFile = null;
    updateRun(params.runId, { slotId: null, taskFile: null });
    console.log(`[run] replay from ${replayStepName} — cleared slotId + taskFile for re-selection`);
  } else if (targetIdx >= 0 && targetIdx <= writeTaskIdx) {
    // Replaying from write-task: clear taskFile so it regenerates with current slot
    replayTaskFile = null;
    updateRun(params.runId, { taskFile: null });
    console.log(`[run] replay from ${replayStepName} — cleared taskFile for regeneration`);
  } else if (existing.slotId) {
    // Re-claim the slot (engine released it on failure)
    try {
      const { updateSlotStatus } = await import('../../core/index.js');
      await updateSlotStatus(existing.slotId, { lifecycle: 'preparing', agent: 'orchestrator' });
      console.log(`[run] replay from ${replayStepName} — re-claimed slot ${existing.slotId}`);
    } catch (err) {
      console.warn(`[run] slot re-claim failed (${(err as Error).message}), clearing slotId`);
      updateRun(params.runId, { slotId: null });
    }
  }

  // Drop branch-affinity nudge hints on any replay. The flags were set at run.create time
  // against a slot snapshot that's now stale — the re-claim above flips agent to
  // 'orchestrator', which fails `verifyBranchAffinityNudgeStillEligible`'s `agent==='working'`
  // gate. Retrying with the same nudge hint hits the same dead end. Engine routes through
  // fresh `dispatchExecute` instead, which is what replay semantics actually want: rebuild
  // the slot from a known state rather than rely on the original busy-worker assumption.
  // Regression introduced by PR #41 (d2442088, 2026-05-01); replays of pre-PR runs always
  // worked because every DISPATCH was fresh.
  if (existing.engineState?.flags?.nudgeReuse || existing.engineState?.flags?.skipPrepare) {
    const newFlags = { ...existing.engineState.flags };
    delete newFlags.nudgeReuse;
    delete newFlags.skipPrepare;
    updateRun(params.runId, {
      engineState: { ...existing.engineState, flags: newFlags },
    });
    console.log(
      `[run] replay from ${replayStepName} — cleared nudgeReuse/skipPrepare flags (fresh dispatch)`,
    );
  }

  // Replaying from self-review or later must clear nested-loop artifacts and active task variants.
  if (
    existing.slotId &&
    existing.taskFile &&
    targetIdx >= 0 &&
    selfReviewIdx >= 0 &&
    targetIdx >= selfReviewIdx
  ) {
    try {
      const {
        loadSlotVars,
        loadProjectVars,
        getProjectField,
        getOrchestratorTaskRoot,
        resolveTaskRelDir,
      } = await import('../../core/config.js');
      const vars = await loadSlotVars(existing.slotId);
      const pv = await loadProjectVars(existing.project).catch(() => null);
      const taskRelDir = resolveTaskRelDir(
        existing.taskFile,
        getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
      );
      if (taskRelDir !== null) {
        const taskDirName = pv
          ? getProjectField(pv.projectJson, 'task_dir') || DEFAULT_TASK_DIR
          : DEFAULT_TASK_DIR;
        const workerTaskDir = `${vars.remoteRepo}/${taskDirName}/${taskRelDir}`;
        const preserveSelfReviewFix =
          existing.agentContexts?.some(
            (ctx) => ctx.role === 'self-review-fix' && ctx.status === 'working',
          ) ?? false;
        const nestedFiles = [
          `${workerTaskDir}/SELF-REVIEW.md`,
          `${workerTaskDir}/SELF-REVIEW-SIGNAL.json`,
          ...(preserveSelfReviewFix
            ? []
            : [
                `${workerTaskDir}/SELF-REVIEW-FIX.md`,
                `${workerTaskDir}/SELF-REVIEW-FIX-SIGNAL.json`,
              ]),
          `${workerTaskDir}/CI-FIX.md`,
          `${workerTaskDir}/CI-FIX-SIGNAL.json`,
        ];
        await execOnSlot(
          vars,
          `rm -f ${nestedFiles.map(shellQuote).join(' ')} 2>/dev/null`,
          vars.remoteRepo,
        );
        console.log(
          `[run] replay from ${replayStepName} — cleared nested-loop task artifacts in ${workerTaskDir}${preserveSelfReviewFix ? ' (preserved active self-review-fix)' : ''}`,
        );
      }
    } catch (err) {
      console.warn(`[run] nested-loop cleanup failed (${(err as Error).message})`);
    }
  }

  const replaysWorkerLaunch =
    targetIdx >= 0 &&
    prepareIdx >= 0 &&
    monitorIdx >= 0 &&
    targetIdx >= prepareIdx &&
    targetIdx <= monitorIdx;

  if (replaysWorkerLaunch && existing.slotId && existing.taskFile) {
    try {
      const {
        loadSlotVars,
        loadProjectVars,
        getProjectField,
        getOrchestratorTaskRoot,
        resolveTaskRelDir,
      } = await import('../../core/config.js');
      const vars = await loadSlotVars(existing.slotId);
      const pv = await loadProjectVars(existing.project).catch(() => null);
      const taskRelDir = resolveTaskRelDir(
        existing.taskFile,
        getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
      );
      if (taskRelDir !== null) {
        const taskDirName = pv
          ? getProjectField(pv.projectJson, 'task_dir') || DEFAULT_TASK_DIR
          : DEFAULT_TASK_DIR;
        const workerTaskDir = `${vars.remoteRepo}/${taskDirName}/${taskRelDir}`;
        await execOnSlot(
          vars,
          `rm -f ${shellQuote(`${workerTaskDir}/SIGNAL.json`)} ` +
            `${shellQuote(`${workerTaskDir}/SELF-REVIEW-SIGNAL.json`)} ` +
            `${shellQuote(`${workerTaskDir}/SELF-REVIEW-FIX-SIGNAL.json`)} ` +
            `${shellQuote(`${workerTaskDir}/CI-FIX-SIGNAL.json`)} 2>/dev/null`,
          vars.remoteRepo,
        );
        console.log(
          `[run] replay from ${replayStepName} — cleared worker terminal signals in ${workerTaskDir}`,
        );
      }
    } catch (err) {
      console.warn(`[run] worker signal cleanup failed (${(err as Error).message})`);
    }
  }

  // Reset this step and all subsequent steps to pending
  const stepIdx = existing.steps.indexOf(step);
  for (let i = stepIdx; i < existing.steps.length; i++) {
    updateRunStep(params.runId, existing.steps[i].name, {
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
      inputs: undefined,
      outputs: undefined,
      detail: undefined,
    });
  }

  // Clear decisions when replaying the completion/gate path so stale CI/review
  // decisions do not short-circuit or re-block it. Preserve resolved human-gate
  // approvals when replaying post-gate steps (finalize/ci-watch): those replays
  // are publish retries for an already-approved package, and clearing the
  // approval makes recovery impossible without forcing a redundant re-review.
  // Flows without a human gate keep the default behavior below: preserve only
  // unresolved decisions rather than inventing a gate boundary they do not have.
  const replaysCompletionOrGate =
    targetIdx >= 0 &&
    completeIdx >= 0 &&
    humanGateIdx >= 0 &&
    targetIdx >= completeIdx &&
    targetIdx <= humanGateIdx;
  const replaysPostGate = targetIdx >= 0 && humanGateIdx >= 0 && targetIdx > humanGateIdx;
  const replaysTaskGeneration = targetIdx >= 0 && writeTaskIdx >= 0 && targetIdx <= writeTaskIdx;
  const clearedDecisions =
    replaysTaskGeneration || replaysCompletionOrGate
      ? []
      : replaysPostGate
        ? existing.decisions
        : existing.decisions.filter((d) => !d.resolvedAt);

  // Reset run status, clear error and stale outcome
  const {
    outcome: _outcome,
    disposition: _disposition,
    terminalEvidence: _terminalEvidence,
    durationMs: _durationMs,
    costEstimate: _costEstimate,
    sessionTurns: _sessionTurns,
    sessionInputTokens: _sessionInputTokens,
    sessionOutputTokens: _sessionOutputTokens,
    sessionCacheCreation: _sessionCacheCreation,
    sessionCacheRead: _sessionCacheRead,
    sessionTotalTokens: _sessionTotalTokens,
    actualModel: _actualModel,
    ...metricsWithoutTerminalOutcome
  } = existing.metrics;
  const resetMetrics = replaysWorkerLaunch
    ? {
        ...metricsWithoutTerminalOutcome,
        nudgeCount: 0,
        runnerSessionId: null,
        runnerSessionPath: null,
      }
    : { ...metricsWithoutTerminalOutcome };
  const attemptCount =
    (existing.recoveryAttempts ?? []).filter(
      (attempt) => attempt.stepName === replayStepName && attempt.triggeredBy === triggeredBy,
    ).length + 1;
  const attempt = {
    id: randomUUID(),
    attempt: attemptCount,
    stepName: replayStepName,
    startedAt: new Date().toISOString(),
    status: 'started' as const,
    triggeredBy,
    ...(params.intelligenceActionId ? { intelligenceActionId: params.intelligenceActionId } : {}),
  };
  const proposalStatus =
    triggeredBy === 'auto-recovery'
      ? ('auto-in-progress' as const)
      : ('manual-in-progress' as const);
  const replayGeneration =
    getRun(params.runId)?.engineState?.generation ?? existing.engineState?.generation ?? 0;
  updateRun(params.runId, {
    status: activeStatusForReplayStep(replayStepName),
    error: undefined,
    completedAt: undefined,
    taskFile: replayTaskFile,
    decisions: clearedDecisions,
    metrics: resetMetrics,
    monitorState: undefined,
    activeTaskFile: undefined,
    recoveryProposal: {
      status: proposalStatus,
      proposalId: params.intelligenceActionId,
      generation: replayGeneration,
    },
    recoveryAttempts: [...(existing.recoveryAttempts ?? []), attempt],
  });
  emit(Events.RUN_UPDATED, { run: getRun(params.runId) });

  // Retry-with-profile: persist the selection so the replayed PREPARE (and any
  // later replay) uses it — profile choice is run state, not a one-shot flag.
  if (params.prepareProfile) {
    updateRun(params.runId, { prepareProfile: params.prepareProfile });
  }

  // Binary operator skip — no health gating (ADR-037 §5)
  if (params.skipPrepare) {
    setRunFlags(params.runId, { skipPrepare: true });
  }

  // Re-drive the engine from the reset step
  startRun(params.runId).catch((err) => {
    console.error(`[run] replay failed: ${(err as Error).message}`);
  });

  console.log(`[run] replaying ${params.runId.slice(0, 8)} from step ${replayStepName}`);
  return { run: getRun(params.runId)! };
}
