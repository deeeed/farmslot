import { randomUUID } from 'node:crypto';

import {
  DEFAULT_TASK_DIR,
  Events,
  FLOW_STEPS,
  type FlowType,
  isInteractiveDevRun,
  PipelineSteps as PS,
  PR_BOUND_FLOW_TYPES,
  resolveRunSlotId,
  type RunReplayStepParams,
  type RunReplayStepResult,
  type RunStatus,
} from '@farmslot/protocol';

import { execOnSlot } from '../../core/exec.js';
import { shellQuote } from '../../core/tmux.js';
import { isFollowUpFlow } from '../../family-observability/context.js';
import { hasValidPrNumber } from '../../run-engine/gate-policy.js';
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

function normalizeReplayPrerequisites(
  runId: string,
  existing: NonNullable<ReturnType<typeof getRun>>,
  flowSteps: readonly string[] | undefined,
  targetIdx: number,
  replayStepName: string,
): void {
  if (!flowSteps || targetIdx <= 0) return;
  const now = new Date().toISOString();
  for (let i = 0; i < targetIdx; i++) {
    const stepName = flowSteps[i];
    const prior = existing.steps.find((candidate) => candidate.name === stepName);
    if (!prior || prior.status === 'done' || prior.status === 'pending') continue;
    updateRunStep(runId, stepName, {
      status: 'done',
      completedAt: prior.completedAt ?? now,
      detail: `Normalized stale ${prior.status} prerequisite before replay from ${replayStepName}`,
      outputs: {
        ...(prior.outputs ?? {}),
        replayPrerequisiteNormalized: true,
        normalizedFromStatus: prior.status,
        normalizedForReplayStep: replayStepName,
      },
    });
  }
}

function recoverReplaySlotId(
  existing: NonNullable<ReturnType<typeof getRun>>,
  targetIdx: number,
  prepareIdx: number,
): string | null {
  if (targetIdx < 0 || prepareIdx < 0 || targetIdx < prepareIdx) return null;
  return resolveRunSlotId(existing);
}

function assertReplayAfterDispatchAllowed(
  existing: NonNullable<ReturnType<typeof getRun>>,
  flowSteps: readonly string[] | undefined,
  targetIdx: number,
  replayStepName: string,
): void {
  const workerLifecycleSteps = new Set<string>([PS.MONITOR, PS.SELF_REVIEW]);
  if (!workerLifecycleSteps.has(replayStepName)) return;
  if (!flowSteps || targetIdx < 0) return;
  const dispatchIdx = flowSteps.indexOf(PS.DISPATCH);
  if (dispatchIdx < 0 || targetIdx <= dispatchIdx) return;

  const dispatchStep = existing.steps.find((candidate) => candidate.name === PS.DISPATCH);
  if (!dispatchStep) {
    throw new Error(
      `Cannot replay ${replayStepName}: dispatch has not completed — replay from dispatch instead`,
    );
  }
  if (dispatchStep.status === 'done') return;
  if (dispatchStep.status === 'failed' && isQueuedPromptDispatchFalseNegative(existing)) return;
  if (dispatchStep.status === 'failed') {
    throw new Error(
      `Cannot replay ${replayStepName}: dispatch failed — replay from dispatch instead`,
    );
  }
  throw new Error(
    `Cannot replay ${replayStepName}: dispatch has not completed — replay from dispatch instead`,
  );
}

type SlotReclaimCheck =
  | { ok: true }
  | { ok: false; reason: 'owned-by-other'; owner: string }
  | { ok: false; reason: 'not-reclaimable'; lifecycle: string };

export function replaySlotReclaimCheck(
  slot: Readonly<Record<string, unknown>>,
  runId: string,
  options?: { ownerRunExists?: (ownerId: string) => boolean },
): SlotReclaimCheck {
  const owner = typeof slot.current_run_id === 'string' ? slot.current_run_id : '';
  if (owner && owner !== runId) {
    const ownerStillActive = options?.ownerRunExists?.(owner) ?? true;
    if (ownerStillActive) return { ok: false, reason: 'owned-by-other', owner };
    return { ok: true };
  }

  const lifecycle = typeof slot.lifecycle === 'string' ? slot.lifecycle : '';
  if (owner === runId) return { ok: true };
  if (lifecycle === '' || lifecycle === 'ready' || lifecycle === 'released') return { ok: true };
  return { ok: false, reason: 'not-reclaimable', lifecycle };
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
  if (existing.readOnly) {
    throw new Error(
      `Run ${params.runId.slice(0, 8)} is a read-only imported reference and cannot be replayed`,
    );
  }
  const triggeredBy = params.triggeredBy ?? 'operator';

  const flowSteps = FLOW_STEPS[existing.flowType];
  const writeTaskIdx = flowSteps ? flowSteps.indexOf(PS.WRITE_TASK) : -1;
  const replayTargetIdx = flowSteps
    ? flowSteps.indexOf(params.stepName as (typeof flowSteps)[number])
    : -1;
  const replayWouldRegenerateTask =
    writeTaskIdx >= 0 && replayTargetIdx >= 0 && replayTargetIdx <= writeTaskIdx;

  // Pre-flight validation: if the stored ticketOrPr doesn't match the flow's expected
  // shape, retrying will hit the same error every time. Fail loudly at the entry so
  // the user understands the run is unrecoverable and needs to be recreated with a
  // correct reference (rather than seeing the same deep "write-task" error repeatedly).
  // Chained follow-ups (merge-main, pr-complete) keep the Jira key in ticketOrPr
  // while prNumber holds the linked PR — same split fetchPRData uses at runtime.
  // Only skip validation for post-write-task replays: write-task still derives PR vars
  // from ticketOrPr and would mis-hydrate tasks if we bypassed on earlier steps.
  const chainedPrReplay =
    PR_BOUND_FLOW_TYPES.has(existing.flowType as FlowType) &&
    hasValidPrNumber(existing) &&
    !replayWouldRegenerateTask;
  if (
    !isInternalArtifactOnlyEvalTicket(existing) &&
    !(isInteractiveDevRun(existing) && isLocalDevRef(existing.ticketOrPr)) &&
    !chainedPrReplay
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

  let replayStepName = params.stepName;
  let targetIdx = replayTargetIdx;
  const findSlotIdx = flowSteps ? flowSteps.indexOf(PS.FIND_SLOT) : -1;
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
  const replaySnapshot = getRun(params.runId) ?? existing;
  assertReplayAfterDispatchAllowed(replaySnapshot, flowSteps, targetIdx, replayStepName);
  normalizeReplayPrerequisites(params.runId, replaySnapshot, flowSteps, targetIdx, replayStepName);

  // Invalidate any in-flight engine loop so it bails instead of overwriting our state.
  // Do this only after replay entry validation so rejected replays do not leave a
  // synthetic in-progress recovery lane behind.
  cancelRunEngine(params.runId);
  bumpRunGeneration(params.runId);

  let replayTaskFile = existing.taskFile ?? null;
  let effectiveSlotId = existing.slotId;

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
    effectiveSlotId = null;
    updateRun(params.runId, { slotId: null, taskFile: null });
    console.log(`[run] replay from ${replayStepName} — cleared slotId + taskFile for re-selection`);
  } else if (targetIdx >= 0 && targetIdx <= writeTaskIdx) {
    // Replaying from write-task: clear taskFile so it regenerates with current slot
    replayTaskFile = null;
    updateRun(params.runId, { taskFile: null });
    console.log(`[run] replay from ${replayStepName} — cleared taskFile for regeneration`);
  } else {
    const replaySlotId = recoverReplaySlotId(replaySnapshot, targetIdx, prepareIdx);
    if (replaySlotId) {
      // Re-claim only when the slot is free or still owned by this run. A released run
      // can keep stale agentContext.slotId history after its slot is reassigned; blindly
      // writing slot status here would steal that physical worker from the new run.
      try {
        const { updateSlotStatusIf } = await import('../../core/index.js');
        const claimed = await updateSlotStatusIf(
          replaySlotId,
          (slot) =>
            replaySlotReclaimCheck(slot, params.runId, {
              ownerRunExists: (ownerId) => Boolean(getRun(ownerId)),
            }).ok,
          {
            lifecycle: 'busy',
            phase: 'preparing',
            agent: 'orchestrator',
            current_run_id: params.runId,
            current_flow_type: existing.flowType || null,
            current_ticket_or_pr: existing.ticketOrPr,
            current_mode: existing.mode ?? null,
            current_family_id: existing.familyId ?? null,
            current_lane: existing.lane ?? null,
            current_variant: existing.variant ?? null,
          },
        );
        if (!claimed) {
          throw new Error(
            `slot ${replaySlotId} is no longer safely reclaimable; replay from find-slot to select a fresh worker`,
          );
        }
        effectiveSlotId = replaySlotId;
        updateRun(params.runId, { slotId: replaySlotId });
        console.log(`[run] replay from ${replayStepName} — re-claimed slot ${replaySlotId}`);
      } catch (err) {
        console.warn(`[run] slot re-claim failed (${(err as Error).message})`);
        throw err;
      }
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
  //
  // CI-watch chained follow-ups (parentRunId + pr-complete/review-pr/merge-main) set
  // skipPrepare because the parent just finished on a keep-warm slot. Clearing that flag
  // on write-task replay forces a full PREPARE and tears down the hot workspace the chain
  // was meant to reuse — preserve it; only nudgeReuse is always stale after replay.
  const isChainedFollowUp = Boolean(existing.parentRunId) && isFollowUpFlow(existing.flowType);
  const willRerunPrepare = targetIdx >= 0 && prepareIdx >= 0 && targetIdx <= prepareIdx;
  const keepHotSlotSkipPrepare = isChainedFollowUp && Boolean(effectiveSlotId);
  if (existing.engineState?.flags?.nudgeReuse || existing.engineState?.flags?.skipPrepare) {
    const newFlags = { ...existing.engineState.flags };
    delete newFlags.nudgeReuse;
    if (!keepHotSlotSkipPrepare) {
      delete newFlags.skipPrepare;
    }
    const currentEngineState = getRun(params.runId)?.engineState ?? existing.engineState;
    updateRun(params.runId, {
      engineState: { ...currentEngineState, flags: newFlags },
    });
    console.log(
      keepHotSlotSkipPrepare
        ? `[run] replay from ${replayStepName} — cleared nudgeReuse; preserved skipPrepare (CI-watch chained follow-up)`
        : `[run] replay from ${replayStepName} — cleared nudgeReuse/skipPrepare flags (fresh dispatch)`,
    );
  } else if (keepHotSlotSkipPrepare && willRerunPrepare) {
    // Prior replay may have already cleared skipPrepare — restore hot-slot semantics.
    setRunFlags(params.runId, { skipPrepare: true });
    console.log(
      `[run] replay from ${replayStepName} — restored skipPrepare (CI-watch chained follow-up)`,
    );
  }

  // Replaying from self-review or later must clear nested-loop artifacts and active task variants.
  if (
    effectiveSlotId &&
    existing.taskFile &&
    targetIdx >= 0 &&
    selfReviewIdx >= 0 &&
    targetIdx >= selfReviewIdx
  ) {
    try {
      const {
        loadSlotVars,
        loadProjectVars,
        getOrchestratorTaskRoot,
        resolveProjectTaskDirName,
        resolveTaskRelDir,
      } = await import('../../core/config.js');
      const vars = await loadSlotVars(effectiveSlotId);
      const pv = await loadProjectVars(existing.project).catch(() => null);
      const taskRelDir = resolveTaskRelDir(
        existing.taskFile,
        getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
      );
      if (taskRelDir !== null) {
        const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
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

  if (replaysWorkerLaunch && effectiveSlotId && existing.taskFile) {
    try {
      const {
        loadSlotVars,
        loadProjectVars,
        getOrchestratorTaskRoot,
        resolveProjectTaskDirName,
        resolveTaskRelDir,
      } = await import('../../core/config.js');
      const vars = await loadSlotVars(effectiveSlotId);
      const pv = await loadProjectVars(existing.project).catch(() => null);
      const taskRelDir = resolveTaskRelDir(
        existing.taskFile,
        getOrchestratorTaskRoot(existing.project, pv?.projectJson ?? null),
      );
      if (taskRelDir !== null) {
        const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
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
