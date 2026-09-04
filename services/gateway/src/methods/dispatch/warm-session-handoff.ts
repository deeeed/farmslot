import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContext,
  type AgentContextTarget,
  agentDispatchWindow,
  type AgentRole,
  type FlowType,
  primaryRoleForFlow,
  type Run,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import {
  claimSlotStatusIf,
  execLocal,
  execOnSlot,
  farmslotRoot,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
  readSlotField,
  readSlotRow,
  resolveProjectTaskDirName,
  SLOT_PHASE_RELEASING,
} from '../../core/index.js';
import { resolveTmuxPaneId, resolveTmuxSession, shellQuote } from '../../core/tmux.js';
import { readLaunchAckSignalSnapshot } from '../../runners/prompt-delivery-evidence.js';
import { normalizeRunner, runnerRetainedSessionHandoff } from '../../runners/registry.js';
import { dispatchStartedAtMs } from '../../runners/session-path-resolution.js';
import { resolvePersistedRunnerSessionBinding } from '../../runners/session-process.js';
import {
  deliverPromptWithRetainedFallback,
  type RetainedSessionDeliveryResult,
} from '../../runners/session-reactivation.js';
import {
  clearedRunnerSessionContextPatch,
  runnerSessionContextPatch,
} from '../../runners/session-record.js';
import { resolveWorkerNudgePrompt } from '../../runners/worker-prompt.js';
import { isWorkerAlive } from '../../self-review/worker-lifecycle.js';
import { copyPreparedTaskRootSidecars } from '../../tasks/sidecars.js';
import { unwatchContext, unwatchSlot, watchContext, watchSlot } from '../../tasks/watcher.js';

import {
  enforceDispatchPressureGate,
  ensureWorkerRoleTarget,
  isRunnerAliveInAnyPane,
} from './execute.js';
import { terminalizePriorRunOnSlot } from './nudge.js';
import { resolveDispatchSafetyTier } from './safety-tier.js';
import { SLOT_CLAIM_REFUSED_CODE, slotClaimBlockedByRelease } from './slot-scoring.js';

type EventEmitter = (event: string, payload: unknown) => void;

export interface WarmSessionHandoffParams {
  slotId: string;
  taskFile: string;
  runId: string;
  ticketOrPr: string;
  flowType: FlowType;
  /** Parent whose live flow-owned worker should receive the chained task. */
  parentRunId?: string | null;
  /** Expected runner from the chained run (must match live slot runner). */
  runner?: string | null;
  /** When set and differs from the slot runner, refuse warm handoff (model/runner swap). */
  model?: string | null;
}

export type WarmSessionHandoffResult =
  | {
      handedOff: true;
      workerTarget: string;
      runner: string;
      model: string | null;
    }
  | {
      handedOff: false;
      reason: string;
      /** A live/ambiguous worker must be held rather than replaced. */
      disposition: 'fresh-dispatch' | 'hold';
    };

export function warmHandoffFailureFromRetainedDelivery(
  delivery: Exclude<RetainedSessionDeliveryResult, { delivered: true }>,
): WarmSessionHandoffResult {
  // This path already proved a live worker exists. Even when in-place safe-send
  // is allowed for another workflow, cold replacement is never safe here.
  return {
    handedOff: false,
    disposition: 'hold',
    reason: delivery.reason,
  };
}

export interface WarmWorkerBinding {
  role: AgentRole;
  context: AgentContext | null;
  target: string | null;
}

export function isWarmHandoffDispatchRecovery(run: Pick<Run, 'recoveryAttempts'>): boolean {
  return (
    run.recoveryAttempts?.some(
      (attempt) =>
        attempt.stepName === 'dispatch' &&
        attempt.status === 'started' &&
        attempt.completedAt == null,
    ) ?? false
  );
}

/**
 * Bind a chained flow to its persisted parent worker, never to whichever tmux
 * window happens to sort first after slot metadata has moved to the child run.
 */
export function resolveWarmWorkerBinding(
  session: string,
  parentRun: Pick<Run, 'flowType' | 'agentContexts'> | null,
  priorFlowType: FlowType | string | null,
  newFlowType: FlowType,
): WarmWorkerBinding {
  const role = parentRun
    ? primaryRoleForFlow(parentRun.flowType)
    : priorFlowType
      ? primaryRoleForFlow(priorFlowType)
      : primaryRoleForFlow(newFlowType);
  const context =
    parentRun?.agentContexts?.find((candidate) => candidate.role === role) ??
    parentRun?.agentContexts?.find((candidate) => candidate.role === 'primary') ??
    null;
  const persistedTarget = context?.target;
  const target =
    persistedTarget?.session === session && persistedTarget.target?.trim()
      ? persistedTarget.target
      : null;
  return { role, context, target };
}

/**
 * Hand a CI-watch chained follow-up into a still-alive worker session left warm
 * after gate-held FINALIZE. Unlike branch-affinity `nudgeDispatch`, this path
 * targets held/ci-watch slots (agent often idle) and probes process liveness
 * instead of busy mid-task eligibility. A false result explicitly distinguishes
 * a safe cold fallback from an ambiguous live session that must be held.
 */
export async function warmSessionHandoffDispatch(
  params: WarmSessionHandoffParams,
  emit: EventEmitter,
): Promise<WarmSessionHandoffResult> {
  const vars = await loadSlotVars(params.slotId);
  if (vars.slotMode === 'disabled') {
    return {
      handedOff: false,
      disposition: 'fresh-dispatch',
      reason: `slot ${params.slotId} is disabled`,
    };
  }

  const step = (name: string, detail: string) => emit('dispatch.step', { name, detail });

  const { getRun } = await import('../../runs/store.js');
  const requestingRun = getRun(params.runId);
  if (!requestingRun) {
    return {
      handedOff: false,
      disposition: 'fresh-dispatch',
      reason: `run ${params.runId} not found`,
    };
  }
  const parentRun = params.parentRunId ? (getRun(params.parentRunId) ?? null) : null;

  const slotRunnerRaw = (await readSlotField(params.slotId, 'runner')) as string | null;
  const slotModelRaw = (await readSlotField(params.slotId, 'model')) as string | null;
  const runner = normalizeRunner(slotRunnerRaw ?? params.runner ?? 'claude');
  const handoffMode = runnerRetainedSessionHandoff(runner);
  if (handoffMode === 'unsupported') {
    return {
      handedOff: false,
      disposition: 'fresh-dispatch',
      reason: `runner '${runner}' does not support retained-session handoff`,
    };
  }
  if (params.runner) {
    const expected = normalizeRunner(params.runner);
    if (expected !== runner) {
      return {
        handedOff: false,
        disposition: 'fresh-dispatch',
        reason: `runner mismatch (slot=${runner}, run=${expected}) — fresh dispatch required`,
      };
    }
  }
  if (
    params.model &&
    params.model !== 'unknown' &&
    slotModelRaw &&
    slotModelRaw !== 'unknown' &&
    params.model !== slotModelRaw
  ) {
    return {
      handedOff: false,
      disposition: 'fresh-dispatch',
      reason: `model mismatch (slot=${slotModelRaw}, run=${params.model}) — fresh dispatch required`,
    };
  }

  step('probe', `Checking warm worker liveness on ${params.slotId} (${runner})`);
  const alive = await isWorkerAlive(vars, runner, params.parentRunId ?? params.runId);
  if (!alive) {
    // Parent run's primary context may still be the only target that hosts the
    // process (chained run has no agent context yet). Retry without runId.
    const aliveUnscoped = await isWorkerAlive(vars, runner);
    if (!aliveUnscoped) {
      return {
        handedOff: false,
        disposition: 'fresh-dispatch',
        reason: 'worker session not alive',
      };
    }
  }

  let projectJson: RawProjectJson = {};
  try {
    projectJson = (await loadProjectVars(vars.projectName)).projectJson;
  } catch (err) {
    console.warn(
      `[dispatch] warm-handoff project vars load failed for ${vars.projectName}: ${(err as Error).message}`,
    );
  }

  let taskFilePath = params.taskFile;
  if (!path.isAbsolute(taskFilePath)) taskFilePath = path.join(farmslotRoot, taskFilePath);
  if (!existsSync(taskFilePath)) {
    return {
      handedOff: false,
      disposition: 'hold',
      reason: `task file not found: ${taskFilePath}`,
    };
  }

  const taskDir = path.dirname(taskFilePath);
  const taskFolderId = path.basename(taskDir);
  const flowSubdir = path.basename(path.dirname(taskDir));
  const flowType = params.flowType;
  const taskDirName = resolveProjectTaskDirName(projectJson);
  const workerTaskDir = `${taskDirName}/${flowSubdir}/${taskFolderId}`;
  const workerTaskAbs = `${vars.remoteRepo}/${workerTaskDir}`;

  step('copy', `Copying TASK.md to ${workerTaskDir}/TASK.md for warm handoff`);
  if (isLocal(vars.host, vars.machine)) {
    await mkdir(workerTaskAbs, { recursive: true });
    await copyFile(taskFilePath, path.join(workerTaskAbs, 'TASK.md'));
  } else {
    await execOnSlot(vars, `mkdir -p ${shellQuote(workerTaskAbs)}`);
    await execLocal(
      `scp -q ${shellQuote(taskFilePath)} ${shellQuote(`${vars.sshTarget}:${workerTaskAbs}/TASK.md`)}`,
    );
  }
  for (const sidecar of await copyPreparedTaskRootSidecars({
    taskDir,
    workerTaskAbs,
    host: vars.host,
    machine: vars.machine,
    sshTarget: vars.sshTarget,
  })) {
    step('copy', `${sidecar} copied`);
  }
  for (const subdir of ['assets', 'inputs', 'artifacts']) {
    const localDir = path.join(taskDir, subdir);
    if (existsSync(localDir)) {
      if (isLocal(vars.host, vars.machine)) {
        await cp(localDir, path.join(workerTaskAbs, subdir), { recursive: true });
      } else {
        await execLocal(
          `rsync -az ${shellQuote(`${localDir}/`)} ${shellQuote(`${vars.sshTarget}:${workerTaskAbs}/${subdir}/`)}`,
        );
      }
      step('copy', `${subdir}/ copied`);
    }
  }

  step('resolve', 'Resolving warm worker role target (no pane teardown)');
  const session = await resolveTmuxSession(vars.slotId, vars, { strict: true });
  const priorFlowTypeRaw = (await readSlotField(params.slotId, 'current_flow_type')) as
    | string
    | null;
  const binding = resolveWarmWorkerBinding(session, parentRun, priorFlowTypeRaw, flowType);
  const workerRole = binding.role;
  const resolvedWorkerTarget =
    binding.target ?? (await ensureWorkerRoleTarget(vars, session, runner, workerRole));
  const workerWindow =
    (binding.target ? binding.context?.target?.window : null) ?? agentDispatchWindow(workerRole);
  const workerTarget = workerWindow ? `${session}:${workerWindow}` : resolvedWorkerTarget;
  const primaryTarget: AgentContextTarget = {
    session,
    window: workerWindow,
    pane: null,
    target: workerTarget,
  };

  // Re-probe the resolved target: role window may differ from unscoped probe.
  const targetAlive = await isRunnerAliveInAnyPane(vars, workerTarget, runner);
  if (!targetAlive) {
    return {
      handedOff: false,
      disposition: 'fresh-dispatch',
      reason: `no live ${runner} runner under ${workerTarget}`,
    };
  }

  step('handoff', `Delivering TASK.md to warm worker at ${workerTarget}`);
  const absoluteTaskMd = `${workerTaskAbs}/TASK.md`;
  const prompt = await resolveWorkerNudgePrompt(vars.projectName, {
    taskFile: absoluteTaskMd,
    taskDir: workerTaskAbs,
  });
  const retainedSession = resolvePersistedRunnerSessionBinding([
    {
      label: 'parent worker context',
      runnerSessionId: binding.context?.runnerSessionId,
      runnerSessionPath: binding.context?.runnerSessionPath,
    },
    {
      label: 'parent run metrics',
      runnerSessionId: parentRun?.metrics.runnerSessionId,
      runnerSessionPath: parentRun?.metrics.runnerSessionPath,
    },
    {
      label: 'requesting run metrics',
      runnerSessionId: requestingRun.metrics.runnerSessionId,
      runnerSessionPath: requestingRun.metrics.runnerSessionPath,
    },
  ]);
  if (handoffMode === 'resume-with-prompt' && retainedSession.reason) {
    return {
      handedOff: false,
      disposition: 'hold',
      reason: retainedSession.reason,
    };
  }
  const retainedSessionId = retainedSession.binding?.runnerSessionId ?? null;
  const retainedSessionPath = retainedSession.binding?.runnerSessionPath ?? null;
  const safetyTier = resolveDispatchSafetyTier({
    runTier: requestingRun.safetyTier ?? parentRun?.safetyTier,
    projectDefaultRaw: projectJson.default_safety_tier,
  });
  const launchAckSignalPath = `${workerTaskAbs}/SIGNAL.json`;
  const launchAckBaseline = await readLaunchAckSignalSnapshot(vars, launchAckSignalPath);
  const recoveringDispatch = isWarmHandoffDispatchRecovery(requestingRun);
  const deliveryOptions = {
    vars,
    target: workerTarget,
    runnerId: runner,
    sessionId: retainedSessionId,
    sessionPath: retainedSessionPath,
    model: slotModelRaw ?? params.model,
    prompt,
    effort: requestingRun.effort ?? parentRun?.effort,
    safetyTier,
    taskDir: workerTaskAbs,
    taskFile: absoluteTaskMd,
    replacementReadySignalPath: binding.context?.signalFile,
    replacementReadySignalAttemptId: binding.context?.signalAttemptId,
    launchAckSignalPath,
    launchAckBaseline,
    priorPromptSendAttempted: recoveringDispatch,
    // Never compare the gateway replay timestamp with a slot filesystem mtime.
    // Recovery accepts only the exact prompt digest or a signal that advances
    // from this slot-local baseline.
    acceptExistingLaunchAck: false,
    recovery: { runId: params.runId, emit },
  };
  // Delivery-boundary pressure gate (MANUAL-000109): warm-session handoff is
  // a new task delivery even though it reuses an existing runner. Keep this
  // check immediately before the send, after target/session resolution, and
  // persist any one-shot consumption before the runner can receive the prompt.
  const latestRequestingRun = getRun(params.runId) ?? requestingRun;
  await enforceDispatchPressureGate({
    machine: vars.machine,
    runId: params.runId,
    run: latestRequestingRun,
    attemptKey: `${params.runId}:${dispatchStartedAtMs(latestRequestingRun) ?? 'no-attempt'}`,
    onInfo: (detail) => step('info', detail),
    deps: {
      persistRun: async (runId, patch) => {
        const { updateRun, persistRunNow } = await import('../../runs/store.js');
        await persistRunNow(updateRun(runId, patch), 'pressure-override-consumption');
      },
    },
  });
  const delivery = await deliverPromptWithRetainedFallback(deliveryOptions);
  if (!delivery.delivered) {
    return warmHandoffFailureFromRetainedDelivery(delivery);
  }
  primaryTarget.pane = await resolveTmuxPaneId(vars, workerTarget);

  const priorOwnerContext = binding.context;
  const priorNudgeCount = priorOwnerContext?.nudgeCount ?? 0;

  await terminalizePriorRunOnSlot(params.slotId, params.runId, 'warm-handoff');
  const handoffClaim = await claimSlotStatusIf(
    params.slotId,
    // Prefer the FIND_SLOT handoff reservation when present; allow claim when
    // the slot is free of a foreign handoff so recovery paths without a prior
    // reservation can still adopt a warm worker.
    (slot) =>
      slotClaimBlockedByRelease(slot) === null &&
      (slot.handoff_run_id == null || slot.handoff_run_id === params.runId),
    {
      lifecycle: 'busy',
      phase: 'working',
      agent: 'working',
      handoff_run_id: null,
      current_run_id: params.runId,
      current_ticket_or_pr: params.ticketOrPr,
      current_flow_type: flowType,
      current_family_id: requestingRun.familyId ?? null,
      current_lane: requestingRun.lane ?? null,
      current_variant: requestingRun.variant ?? null,
      task_id: taskFolderId,
      task_file: `${workerTaskDir}/TASK.md`,
      dispatched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      runner,
      ...(slotModelRaw && slotModelRaw !== 'unknown' ? { model: slotModelRaw } : {}),
    },
  );
  if (!handoffClaim.claimed) {
    throw Object.assign(
      new Error(`Slot ${params.slotId} is mid-release; warm handoff cannot claim it`),
      { code: SLOT_CLAIM_REFUSED_CODE },
    );
  }

  const workingContext = await upsertAgentContext(params.runId, workerRole, {
    status: 'working',
    taskFile: `${workerTaskDir}/TASK.md`,
    signalFile: `${workerTaskDir}/SIGNAL.json`,
    runner,
    target: primaryTarget,
    nudgeCount: priorNudgeCount + 1,
    ...(runnerSessionContextPatch(
      { runnerSessionId: retainedSessionId, runnerSessionPath: retainedSessionPath },
      'retained warm handoff',
    ) ?? clearedRunnerSessionContextPatch()),
  });
  step(
    'handoff',
    `Warm session handed off on ${workerTarget} (role=${workerRole}, nudgeCount=${priorNudgeCount + 1})`,
  );

  if (workingContext) {
    await watchContext(params.slotId, workingContext);
  } else {
    await watchSlot(params.slotId);
  }

  const rowAfterWatch = await readSlotRow(params.slotId);
  const stillOwned =
    rowAfterWatch != null &&
    rowAfterWatch.current_run_id === params.runId &&
    rowAfterWatch.phase !== SLOT_PHASE_RELEASING;
  if (!stillOwned) {
    if (workingContext) {
      await unwatchContext(params.slotId, workingContext.id, { expectedRunId: params.runId });
    } else {
      await unwatchSlot(params.slotId, { expectedRunId: params.runId });
    }
    throw new Error(
      `Slot ${params.slotId} was released while warm handoff was completing; run ${params.runId} no longer owns it`,
    );
  }

  emit('dispatch.done', { slotId: params.slotId, taskId: taskFolderId, runner, warmHandoff: true });
  return {
    handedOff: true,
    workerTarget,
    runner,
    model: slotModelRaw,
  };
}
