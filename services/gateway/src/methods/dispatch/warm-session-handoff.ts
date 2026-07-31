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
import { resolveTmuxSession, shellQuote } from '../../core/tmux.js';
import {
  normalizeRunner,
  resolveSafeSendTimeoutMs,
  runnerSupportsTmuxNudges,
  sendRunnerInstructionSafely,
} from '../../runners/registry.js';
import { resolveWorkerNudgePrompt } from '../../runners/worker-prompt.js';
import { isWorkerAlive } from '../../self-review/worker-lifecycle.js';
import { copyPreparedTaskRootSidecars } from '../../tasks/sidecars.js';
import { unwatchContext, unwatchSlot, watchContext, watchSlot } from '../../tasks/watcher.js';

import { ensureWorkerRoleTarget, isRunnerAliveInAnyPane } from './execute.js';
import { terminalizePriorRunOnSlot } from './nudge.js';
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
    };

export interface WarmWorkerBinding {
  role: AgentRole;
  context: AgentContext | null;
  target: string | null;
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
 * instead of busy mid-task eligibility. Callers fall back to fresh dispatch
 * when this returns `handedOff: false`.
 */
export async function warmSessionHandoffDispatch(
  params: WarmSessionHandoffParams,
  emit: EventEmitter,
): Promise<WarmSessionHandoffResult> {
  const vars = await loadSlotVars(params.slotId);
  if (vars.slotMode === 'disabled') {
    return { handedOff: false, reason: `slot ${params.slotId} is disabled` };
  }

  const step = (name: string, detail: string) => emit('dispatch.step', { name, detail });

  const { getRun } = await import('../../runs/store.js');
  const requestingRun = getRun(params.runId);
  if (!requestingRun) {
    return { handedOff: false, reason: `run ${params.runId} not found` };
  }
  const parentRun = params.parentRunId ? (getRun(params.parentRunId) ?? null) : null;

  const slotRunnerRaw = (await readSlotField(params.slotId, 'runner')) as string | null;
  const slotModelRaw = (await readSlotField(params.slotId, 'model')) as string | null;
  const runner = normalizeRunner(slotRunnerRaw ?? params.runner ?? 'claude');
  if (!runnerSupportsTmuxNudges(runner)) {
    return {
      handedOff: false,
      reason: `runner '${runner}' does not support tmux warm handoff`,
    };
  }
  if (params.runner) {
    const expected = normalizeRunner(params.runner);
    if (expected !== runner) {
      return {
        handedOff: false,
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
      return { handedOff: false, reason: 'worker session not alive' };
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
    return { handedOff: false, reason: `task file not found: ${taskFilePath}` };
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
  const workerTarget =
    binding.target ?? (await ensureWorkerRoleTarget(vars, session, runner, workerRole));
  const primaryTarget: AgentContextTarget = {
    session,
    window:
      (binding.target ? binding.context?.target?.window : null) ?? agentDispatchWindow(workerRole),
    pane: binding.target ? (binding.context?.target?.pane ?? null) : null,
    target: workerTarget,
  };

  // Re-probe the resolved target: role window may differ from unscoped probe.
  const targetAlive = await isRunnerAliveInAnyPane(vars, workerTarget, runner);
  if (!targetAlive) {
    return { handedOff: false, reason: `no live ${runner} runner under ${workerTarget}` };
  }

  step('handoff', `Sending TASK.md prompt to warm worker at ${workerTarget}`);
  const absoluteTaskMd = `${workerTaskAbs}/TASK.md`;
  const prompt = await resolveWorkerNudgePrompt(vars.projectName, {
    taskFile: absoluteTaskMd,
    taskDir: workerTaskAbs,
  });
  const nudgeTimeoutMs = resolveSafeSendTimeoutMs(runner);
  const sent = await sendRunnerInstructionSafely(
    vars,
    workerTarget,
    runner,
    prompt,
    '[warm-handoff]',
    nudgeTimeoutMs,
    { forceBusyPoll: true, recovery: { runId: params.runId, emit } },
  );
  if (!sent) {
    return {
      handedOff: false,
      reason: `warm handoff to ${workerTarget} timed out after ${Math.round(nudgeTimeoutMs / 1000)}s`,
    };
  }

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
