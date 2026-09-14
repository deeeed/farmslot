import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
  NATIVE_WORKER_TRANSFER,
  type NativeWorkerCancelResult,
} from '@farmslot/agent-runtime/native';
import { nativeWorkerLaunchDigest } from '@farmslot/agent-runtime/native/worker-launch';
import {
  type AgentContext,
  type AgentRole,
  contextIdFor,
  isTerminalRunStatus,
  Methods,
  nativeProfileSessionParams,
  type NativeSessionInfo,
  type NativeSessionReadResult,
  type NativeSessionSendResult,
  nativeWorkerBindingIsHeld,
  type NativeWorkerSessionBinding,
  primaryRoleForFlow,
  type SafetyTier,
  sameNativeProfileReference,
} from '@farmslot/protocol';

import { TERMINAL_AGENT_STATUSES, upsertAgentContext } from '../../agents/contexts.js';
import { resolveNativeContext } from '../../agents/native-context.js';
import {
  isLocal,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
  readSlotRow,
  updateSlotStatusIf,
} from '../../core/index.js';
import { slotRealpath } from '../../core/slot-io.js';
import { shellQuote } from '../../core/tmux.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { currentSessionOriginator } from '../../security/work-originator.js';
import { unwatchContext, watchContext } from '../../tasks/watcher.js';
import { RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../launch-command.js';

import { routeNativeExecution } from './node.js';
import { NativeSlotOwnershipError, NativeWorkerOperationUncertainError } from './worker-error.js';
import { prepareNativeWorkerLaunch } from './worker-launch.js';
import {
  inspectNativeWorkerProfile,
  nativeWorkerProfileForRunner,
  nativeWorkerProfileMatches,
} from './worker-profile.js';

function ownedRun(runId: string) {
  const run = getRun(runId);
  if (!run || run.transport !== 'native' || !run.nativeOwnerPrincipalId)
    throw new Error('Native worker dispatch requires an owned native run');
  assertNativeRunOwner(run);
  return run;
}

function runnable(runId: string, slotId: string, allowOperatorWait = false) {
  const run = ownedRun(runId);
  if (
    run.slotId !== slotId ||
    isTerminalRunStatus(run.status) ||
    (!allowOperatorWait && ['paused', 'blocked'].includes(run.status))
  )
    throw new Error('Native worker run is no longer admitted for input');
  return run;
}

function target(binding: NativeWorkerSessionBinding) {
  return { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
}

function checkedSession(info: NativeSessionInfo, binding: NativeWorkerSessionBinding) {
  if (
    info.id !== binding.sessionId ||
    info.executionNodeId !== binding.executionNodeId ||
    info.ownerPrincipalId !== binding.ownerPrincipalId ||
    info.workerLeaseId !== binding.leaseId ||
    !nativeWorkerProfileMatches(info, binding)
  )
    throw new Error('Native worker session identity or task lease changed');
  if (binding.generation && info.generation !== binding.generation)
    throw new Error('Native worker generation changed; reconcile recovery before continuing');
  return info;
}

async function finishNativeHandoffSource(
  destinationRunId: string,
  binding: NativeWorkerSessionBinding,
  slotId: string,
  machineTransitionHeld = false,
): Promise<void> {
  const from = binding.handoffFrom;
  if (!from) return;
  const sourceRun = getRun(from.runId);
  if (!sourceRun) return;
  assertNativeRunOwner(sourceRun);
  if (sourceRun.nativeOwnerPrincipalId !== binding.ownerPrincipalId)
    throw new Error('Native handoff source owner changed');
  const sourceContext = sourceRun.agentContexts?.find((context) => context.id === from.contextId);
  if (
    !sourceContext?.nativeSession ||
    sourceContext.nativeSession.sessionId !== binding.sessionId ||
    sourceContext.nativeSession.leaseId !== from.leaseId
  )
    throw new Error('Retained source binding changed before transfer acknowledgement');
  await unwatchContext(slotId, from.contextId, { expectedRunId: sourceRun.id });
  await upsertAgentContext(
    sourceRun.id,
    sourceContext.role,
    { id: from.contextId },
    {
      mirrorIf: (slot) => slot.current_run_id === sourceRun.id,
      resolvePatch: (latest) => {
        if (
          latest?.nativeSession?.sessionId !== binding.sessionId ||
          latest.nativeSession.leaseId !== from.leaseId
        )
          throw new Error('Retained source binding changed during acknowledgement');
        return {
          status: 'complete',
          nativeSession: {
            ...latest.nativeSession,
            releasedAt: latest.nativeSession.releasedAt ?? new Date().toISOString(),
          },
        };
      },
    },
  );
  await persistRunNow(ownedRun(sourceRun.id), 'native task lease released');
  if (sourceRun.id !== destinationRunId && !isTerminalRunStatus(sourceRun.status)) {
    const { runCancel, runCancelTransitionLocked } =
      await import('../../methods/run/lifecycle-control.js');
    const params = { runId: sourceRun.id, reason: `Worker handed to run ${destinationRunId}` };
    const { withRunTransitionWhileMachineHeld } =
      await import('../../run-lifecycle/transition-coordinator.js');
    const result = machineTransitionHeld
      ? await withRunTransitionWhileMachineHeld(sourceRun.id, () =>
          runCancelTransitionLocked(params),
        )
      : await runCancel(params);
    if (result.effects?.some((effect) => effect.status === 'failed'))
      throw new Error('Retained source run did not finish its cancellation effects');
  }
}

export async function cancelNativeWorkerContext(
  runId: string,
  context: AgentContext,
  options: { machineTransitionHeld?: boolean } = {},
): Promise<void> {
  const run = ownedRun(runId);
  const selected = run.agentContexts?.find((item) => item.id === context.id);
  const resolved = resolveNativeContext(run, selected);
  if (selected?.nativeSessionOwner && !resolved)
    throw new Error('Native subtask no longer references its worker lease');
  const current = resolved?.owner;
  if (current) context = current;
  const initialBinding = current?.nativeSession;
  if (
    !initialBinding ||
    initialBinding.releasedAt ||
    (initialBinding.closedAt && !initialBinding.recovery)
  )
    return;
  let binding: NativeWorkerSessionBinding = initialBinding;
  const readRecoveryForStop = async () => {
    const before = binding;
    const snapshot = (await routeNativeExecution(
      before.ownerPrincipalId,
      Methods.NATIVE_SESSION_READ,
      { ...target(before), limit: 1 },
    )) as NativeSessionReadResult;
    checkedSession(snapshot.session, { ...before, generation: snapshot.session.generation });
    if (snapshot.session.nativeSessionId !== current?.runnerSessionId)
      throw new Error('Native recovery stop returned another conversation');
    if (snapshot.session.generation !== before.generation) {
      if (before.recovery?.fromGeneration !== before.generation)
        throw new Error('Native generation changed without the expected recovery intent');
      const saved = await upsertAgentContext(
        runId,
        context.role,
        { id: context.id },
        {
          mirrorIf: (slot) => slot.current_run_id === runId,
          resolvePatch: (latest) => {
            if (
              !latest?.nativeSession ||
              latest.nativeSession.generation !== before.generation ||
              latest.nativeSession.leaseId !== before.leaseId ||
              latest.nativeSession.sessionId !== before.sessionId ||
              latest.nativeSession.recovery?.commandId !== before.recovery?.commandId
            )
              throw new Error('Native recovery changed during stop reconciliation');
            return {
              nativeSession: {
                ...latest.nativeSession,
                generation: snapshot.session.generation,
                closedAt: undefined,
              },
            };
          },
        },
      );
      binding = saved!.nativeSession!;
      await persistRunNow(ownedRun(runId), 'native recovery stop generation');
    }
    return snapshot;
  };
  if (binding.recovery) await readRecoveryForStop();
  if (binding.launchRequestedAt) {
    let stopped = false;
    // A recovery can establish at most one successor generation before its
    // operation fence reaches the host. Reconcile that race once, then fail closed.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = binding;
      const result = (await routeNativeExecution(before.ownerPrincipalId, NATIVE_WORKER_CANCEL, {
        ...target(before),
        generation: before.generation,
        leaseId: before.leaseId,
        ...(before.recovery ? { resumeCommandId: before.recovery.commandId } : {}),
        ...(!before.handoffCompletedAt && before.handoffFrom
          ? { sourceLeaseId: before.handoffFrom.leaseId }
          : {}),
      })) as NativeWorkerCancelResult;
      if (
        (result.cancelled !== true &&
          !(before.recovery && result.reason === 'generation-changed')) ||
        result.sessionId !== before.sessionId ||
        result.leaseId !== before.leaseId
      )
        throw new Error('Native worker stop is unconfirmed');
      const session = before.recovery ? (await readRecoveryForStop()).session : result.session;
      if (before.recovery && session!.generation !== before.generation) continue;
      if (!result.cancelled)
        throw new Error('Native cancellation generation change was not confirmed');
      if (
        session &&
        (!['closed', 'failed'].includes(session.state) ||
          (session.processPid && !session.processStopped))
      )
        throw new Error('Native worker process cleanup is unconfirmed');
      stopped = true;
      break;
    }
    if (!stopped) throw new Error('Native recovery generation did not settle during cancellation');
  }
  await upsertAgentContext(
    runId,
    context.role,
    { id: context.id },
    {
      mirrorIf: (slot) => slot.current_run_id === runId,
      resolvePatch: (latest) => {
        if (
          !latest?.nativeSession ||
          latest.nativeSession.sessionId !== binding.sessionId ||
          latest.nativeSession.leaseId !== binding.leaseId ||
          latest.nativeSession.generation !== binding.generation ||
          latest.nativeSession.recovery?.commandId !== binding.recovery?.commandId
        )
          throw new Error('Native worker binding changed during stop');
        return {
          nativeSession: {
            ...latest.nativeSession,
            closedAt: new Date().toISOString(),
            ...(latest.nativeSession.recovery
              ? { recoveryEpoch: (latest.nativeSession.recoveryEpoch ?? 0) + 1 }
              : {}),
            recovery: undefined,
          },
          status: TERMINAL_AGENT_STATUSES.has(latest.status) ? latest.status : 'idle',
          completedAt: latest.completedAt ?? new Date().toISOString(),
        };
      },
    },
  );
  await persistRunNow(ownedRun(runId), 'native worker stop');
  if (binding.handoffFrom && !binding.handoffCompletedAt)
    await finishNativeHandoffSource(runId, binding, current!.slotId, options.machineTransitionHeld);
}

export async function cancelNativeRunWorkers(
  runId: string,
  options: { machineTransitionHeld?: boolean } = {},
): Promise<void> {
  const run = ownedRun(runId);
  for (const context of run.agentContexts ?? [])
    if (context.nativeSession) await cancelNativeWorkerContext(run.id, context, options);
}

/** Retire only run-owned native workers on the reused slot; standalone Copilot sessions are separate. */
export function assertNativeSlotReplacementOwner(slotId: string, incomingRunId?: string): void {
  const actor = currentSessionOriginator();
  const incoming = incomingRunId ? getRun(incomingRunId) : null;
  const principalId =
    actor.kind === 'principal'
      ? actor.principalId
      : (incoming?.nativeOwnerPrincipalId ?? incoming?.createdByPrincipalId);
  for (const previous of getAllRuns()) {
    if (previous.id === incomingRunId || previous.slotId !== slotId) continue;
    const held = previous.agentContexts?.some((context) =>
      nativeWorkerBindingIsHeld(context.nativeSession),
    );
    if (held && (!principalId || principalId !== previous.nativeOwnerPrincipalId))
      throw new NativeSlotOwnershipError(
        'Native worker slot replacement requires its profile owner',
      );
  }
}

export interface NativeRetainedSource {
  runId: string;
  contextId: string;
}

export async function retireNativeWorkersForSlot(
  slotId: string,
  exceptRunId?: string,
  preserve?: NativeRetainedSource,
  options: { machineTransitionHeld?: boolean } = {},
): Promise<void> {
  assertNativeSlotReplacementOwner(slotId, exceptRunId);
  for (const run of getAllRuns()) {
    if (run.id === exceptRunId || run.slotId !== slotId) continue;
    for (const context of run.agentContexts ?? []) {
      if (run.id === preserve?.runId && context.id === preserve.contextId) continue;
      if (nativeWorkerBindingIsHeld(context.nativeSession))
        try {
          await cancelNativeWorkerContext(run.id, context, options);
        } catch (error) {
          throw new NativeWorkerOperationUncertainError(
            'handoff',
            'The previous native worker has not confirmed stop; the slot remains held.',
            error,
          );
        }
    }
  }
}

export async function dispatchNativeWorker(input: {
  runId: string;
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  role: AgentRole;
  contextId?: string;
  allowOperatorWait?: boolean;
  initialPrompt?: string;
  retainedFrom?: NativeRetainedSource;
  taskFile: string;
  signalFile: string;
  taskId: string;
  runner: string;
  model: string;
  effort?: string;
  safetyTier: SafetyTier;
  domain?: string;
  project: RawProjectJson;
  projectVars?: ProjectVars;
  accountLabel?: string;
  beforeInput: () => Promise<void>;
  assertCurrent?: () => void;
  emit: (event: string, payload: unknown) => void;
}): Promise<{ dispatched: boolean }> {
  const vars = { ...input.vars, remoteRepo: await slotRealpath(input.vars, input.vars.remoteRepo) };
  const runGeneration = getRun(input.runId)?.engineState?.generation ?? 0;
  const checkRun = () => {
    input.assertCurrent?.();
    if ((getRun(input.runId)?.engineState?.generation ?? 0) !== runGeneration)
      throw new Error('Native worker dispatch generation changed');
    return runnable(
      input.runId,
      vars.slotId,
      input.allowOperatorWait === true && input.role === 'self-review',
    );
  };
  const run = checkRun();
  const contextId = input.contextId ?? contextIdFor(input.role);
  const node = isLocal(vars.host, vars.machine) ? 'local' : vars.machine;
  const existingBinding = run.agentContexts?.find(
    (context) => context.id === contextId,
  )?.nativeSession;
  let retained: AgentContext | undefined;
  if (input.retainedFrom && !existingBinding) {
    const sourceRun = ownedRun(input.retainedFrom.runId);
    retained = sourceRun.agentContexts?.find(
      (context) => context.id === input.retainedFrom!.contextId,
    );
    const source = retained?.nativeSession;
    if (
      sourceRun.slotId !== vars.slotId ||
      sourceRun.nativeOwnerPrincipalId !== run.nativeOwnerPrincipalId ||
      !source?.generation ||
      (source.closedAt && !retained?.runnerSessionId) ||
      source.releasedAt ||
      source.recovery ||
      source.executionNodeId !== node ||
      retained?.runner !== input.runner ||
      retained.model !== input.model ||
      retained.taskFile === input.taskFile
    )
      throw new NativeWorkerOperationUncertainError(
        'handoff',
        'Retained worker does not match the requested task, slot, owner or model.',
        undefined,
      );
  }
  const source = retained?.nativeSession;
  const requestedProfile = nativeWorkerProfileForRunner(run, input.runner);
  if (source && requestedProfile && !sameNativeProfileReference(source.profile, requestedProfile))
    throw new Error('Retained worker belongs to another native configuration profile');
  const selectedProfile =
    source?.profile ?? existingBinding?.profile ?? nativeWorkerProfileForRunner(run, input.runner);
  if (selectedProfile && !existingBinding) {
    await inspectNativeWorkerProfile(run.nativeOwnerPrincipalId!, selectedProfile);
    checkRun();
  }
  const proposed: NativeWorkerSessionBinding = source
    ? {
        ...source,
        leaseId: randomUUID(),
        commandId: randomUUID(),
        handoffFrom: { ...input.retainedFrom!, leaseId: source.leaseId },
        handoffCompletedAt: undefined,
        closedAt: undefined,
        acceptedAt: undefined,
        recovery: undefined,
        launchRequestedAt: new Date().toISOString(),
      }
    : {
        sessionId: randomUUID(),
        leaseId: randomUUID(),
        commandId: randomUUID(),
        ownerPrincipalId: run.nativeOwnerPrincipalId!,
        executionNodeId: node,
        ...(selectedProfile ? { profile: selectedProfile } : {}),
      };
  const context = await upsertAgentContext(
    run.id,
    input.role,
    { id: contextId },
    {
      resolvePatch: (existing) => {
        checkRun();
        if (existing?.nativeSession) {
          if (
            existing.taskFile !== input.taskFile ||
            existing.runner !== input.runner ||
            existing.model !== input.model
          )
            throw new Error('Native worker task/configuration changed; use an explicit handoff');
          return {};
        }
        if (existing?.target) throw new Error('Retire the previous transport before native launch');
        return {
          status: 'launching',
          taskFile: input.taskFile,
          signalFile: input.signalFile,
          runner: input.runner,
          model: input.model,
          target: null,
          nativeSession: proposed,
          ...(retained?.runnerSessionId
            ? { runnerSessionId: retained.runnerSessionId, runnerSessionPath: null }
            : {}),
        };
      },
    },
  );
  if (!context?.nativeSession) throw new Error('Native worker reservation was not recorded');
  let binding = context.nativeSession;
  if (binding.closedAt || binding.releasedAt)
    throw new Error('Native worker task lease is closed; use explicit recovery');
  if (binding.ownerPrincipalId !== run.nativeOwnerPrincipalId || binding.executionNodeId !== node)
    throw new Error('Native worker reservation belongs to another execution context');
  await persistRunNow(ownedRun(run.id), 'native worker reservation');

  const admission = async () => {
    await input.beforeInput();
    const slot = await readSlotRow(vars.slotId);
    if (slot?.current_run_id !== run.id || slot.phase === 'releasing')
      throw new Error('Native worker slot ownership changed');
    const live = checkRun().agentContexts?.find((item) => item.id === contextId)?.nativeSession;
    if (
      !live ||
      live.sessionId !== binding.sessionId ||
      live.leaseId !== binding.leaseId ||
      (binding.generation && live.generation !== binding.generation) ||
      live.closedAt ||
      live.releasedAt
    )
      throw new Error('Native worker task binding changed');
  };
  await admission();
  if (
    binding.accountLabel &&
    input.accountLabel !== undefined &&
    input.accountLabel !== binding.accountLabel
  )
    throw new Error('Native worker account changed; retire the existing task lease first');
  if (
    binding.launchDigest &&
    (binding.safetyTier !== input.safetyTier ||
      (input.effort !== undefined && input.effort !== 'auto' && input.effort !== binding.effort))
  )
    throw new Error('Native worker execution settings changed; explicit recovery is required');
  if (!binding.launchDigest && !binding.stateDirectory) {
    const state = (await routeNativeExecution(
      binding.ownerPrincipalId,
      NATIVE_WORKER_STATE,
      target(binding),
    )) as { stateDirectory: string };
    if (!path.posix.isAbsolute(state.stateDirectory))
      throw new Error('Native host returned an invalid worker state directory');
    await admission();
    const saved = await upsertAgentContext(
      run.id,
      input.role,
      { id: contextId },
      {
        resolvePatch: (latest) => {
          checkRun();
          if (
            latest?.nativeSession?.sessionId !== binding.sessionId ||
            latest.nativeSession.leaseId !== binding.leaseId ||
            latest.nativeSession.launchDigest
          )
            throw new Error('Native worker state reservation changed');
          if (
            latest.nativeSession.stateDirectory &&
            latest.nativeSession.stateDirectory !== state.stateDirectory
          )
            throw new Error('Native worker state directory changed');
          return {
            nativeSession: { ...latest.nativeSession, stateDirectory: state.stateDirectory },
          };
        },
      },
    );
    binding = saved!.nativeSession!;
    await persistRunNow(ownedRun(run.id), 'native worker state reservation');
  }
  const prepared = await prepareNativeWorkerLaunch({
    ...input,
    vars,
    taskDir: path.posix.dirname(input.taskFile),
    leaseId: binding.leaseId,
    sessionId: binding.sessionId,
    prepareAccount: !binding.launchDigest,
    accountLabel: binding.accountLabel ?? input.accountLabel,
    profile: binding.profile,
    stateDirectory: binding.stateDirectory,
    effort: binding.launchDigest ? (binding.effort ?? 'auto') : input.effort,
    recordAccount: async (accountLabel) => {
      const selected = await upsertAgentContext(
        run.id,
        input.role,
        { id: contextId },
        {
          resolvePatch: (latest) => {
            checkRun();
            if (
              latest?.nativeSession?.sessionId !== binding.sessionId ||
              latest.nativeSession.leaseId !== binding.leaseId
            )
              throw new Error('Native worker reservation changed during account selection');
            if (
              latest.nativeSession.accountLabel &&
              latest.nativeSession.accountLabel !== accountLabel
            )
              throw new Error('Native worker account selection changed');
            return { nativeSession: { ...latest.nativeSession, accountLabel } };
          },
        },
      );
      if (!selected?.nativeSession)
        throw new Error('Native worker account selection was not recorded');
      binding = selected.nativeSession;
      await persistRunNow(ownedRun(run.id), 'native worker account selection');
    },
  });
  const digest = nativeWorkerLaunchDigest(prepared.launch);
  if (binding.launchDigest && binding.launchDigest !== digest)
    throw new Error('Native worker launch configuration changed; explicit recovery is required');
  const save = async (next: NativeWorkerSessionBinding, patch: Partial<AgentContext> = {}) => {
    const saved = await upsertAgentContext(
      run.id,
      input.role,
      { id: contextId },
      {
        resolvePatch: (latest) => {
          checkRun();
          if (
            latest?.nativeSession?.sessionId !== binding.sessionId ||
            latest.nativeSession.leaseId !== binding.leaseId
          )
            throw new Error('Native worker binding changed before persistence');
          if (
            latest.nativeSession.closedAt ||
            latest.nativeSession.releasedAt ||
            (latest.nativeSession.generation &&
              next.generation &&
              latest.nativeSession.generation !== next.generation) ||
            (latest.nativeSession.launchDigest &&
              next.launchDigest &&
              latest.nativeSession.launchDigest !== next.launchDigest)
          )
            throw new Error('Native worker generation or launch configuration changed');
          return {
            ...patch,
            nativeSession: {
              ...latest.nativeSession,
              ...next,
              generation: next.generation ?? latest.nativeSession.generation,
            },
            target: null,
          };
        },
      },
    );
    if (!saved?.nativeSession) throw new Error('Native worker binding was not saved');
    binding = saved.nativeSession;
    await persistRunNow(ownedRun(run.id), 'native worker intent');
    return saved;
  };
  await save({
    ...binding,
    launchDigest: digest,
    accountLabel: prepared.accountLabel,
    effort: prepared.launch.effort,
    safetyTier: prepared.launch.safetyTier,
    launchRequestedAt: binding.launchRequestedAt ?? new Date().toISOString(),
  });
  await admission();
  if (binding.handoffFrom && !binding.handoffCompletedAt) {
    try {
      const from = binding.handoffFrom;
      const sourceRun = getRun(from.runId);
      if (sourceRun) assertNativeRunOwner(sourceRun);
      const snapshot = (await routeNativeExecution(
        binding.ownerPrincipalId,
        Methods.NATIVE_SESSION_READ,
        target(binding),
      )) as NativeSessionReadResult;
      if (
        snapshot.session.cwd !== vars.remoteRepo ||
        snapshot.session.generation !== binding.generation ||
        ![from.leaseId, binding.leaseId].includes(snapshot.session.workerLeaseId ?? '')
      )
        throw new Error('Retained worker execution context changed');
      if (
        snapshot.session.workerLeaseId === from.leaseId &&
        ((snapshot.session.state !== 'idle' &&
          !(
            ['closed', 'failed'].includes(snapshot.session.state) && snapshot.session.processStopped
          )) ||
          snapshot.pendingRequests.length)
      )
        throw new Error(
          'Retained worker must be idle or confirmed stopped, with no pending requests',
        );
      if (sourceRun && sourceRun.id !== run.id && !isTerminalRunStatus(sourceRun.status)) {
        // Fence the prior engine before transfer. A failed/uncertain transfer leaves it
        // paused and the successor holds the slot until this same lease is reconciled.
        const { cancelRunEngine, bumpRunGeneration } =
          await import('../../run-engine/orchestrator.js');
        cancelRunEngine(sourceRun.id);
        bumpRunGeneration(sourceRun.id);
        updateRun(sourceRun.id, { status: 'paused' });
        await persistRunNow(ownedRun(sourceRun.id), 'native handoff source pause');
      }
      await admission();
      const transferred = (await routeNativeExecution(
        binding.ownerPrincipalId,
        NATIVE_WORKER_TRANSFER,
        {
          ...target(binding),
          generation: binding.generation,
          leaseId: from.leaseId,
          launch: prepared.launch,
        },
      )) as { session: NativeSessionInfo };
      checkedSession(transferred.session, binding);
      await finishNativeHandoffSource(run.id, binding, vars.slotId);
      await save({ ...binding, handoffCompletedAt: new Date().toISOString() });
    } catch (error) {
      throw new NativeWorkerOperationUncertainError(
        'handoff',
        'Native task lease transfer is unconfirmed; retry reconciliation without replacing the session.',
        error,
      );
    }
  }
  if (binding.handoffFrom && !binding.acceptedAt) {
    try {
      const snapshot = (await routeNativeExecution(
        binding.ownerPrincipalId,
        Methods.NATIVE_SESSION_READ,
        target(binding),
      )) as NativeSessionReadResult;
      if (binding.recovery || snapshot.session.processStopped) {
        const { resumeNativeWorker } = await import('./worker-recovery.js');
        await resumeNativeWorker(run.id, {
          purpose: 'handoff',
          contextId,
          assertCurrent: () => {
            checkRun();
          },
        });
        const resumed = checkRun().agentContexts?.find(
          (candidate) => candidate.id === contextId,
        )?.nativeSession;
        if (
          !resumed ||
          resumed.sessionId !== binding.sessionId ||
          resumed.leaseId !== binding.leaseId
        )
          throw new Error('Saved worker handoff binding changed during recovery');
        binding = resumed;
      }
    } catch (error) {
      throw new NativeWorkerOperationUncertainError(
        'launch',
        'Saved worker handoff recovery is unconfirmed; reconcile the existing reservation before retrying.',
        error,
      );
    }
  }
  let info: NativeSessionInfo;
  try {
    const created = (await routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_ENSURE, {
      ...target(binding),
      ...nativeProfileSessionParams(binding.profile),
      runner: input.runner,
      model: input.model,
      cwd: vars.remoteRepo,
      launch: prepared.launch,
    })) as { session: NativeSessionInfo };
    info = checkedSession(created.session, binding);
  } catch (error) {
    throw new NativeWorkerOperationUncertainError(
      'launch',
      `Native worker launch is unconfirmed: ${(error as Error).message}`,
      error,
    );
  }
  if (info.state === 'closed' || info.state === 'failed')
    throw new NativeWorkerOperationUncertainError(
      'launch',
      'Native worker reservation is terminal. Explicit recovery is required.',
      undefined,
    );
  await save(
    { ...binding, generation: info.generation },
    { runnerSessionId: info.nativeSessionId, runnerSessionPath: null },
  );
  if (!binding.acceptedAt) {
    try {
      const existing = (await routeNativeExecution(
        binding.ownerPrincipalId,
        Methods.NATIVE_SESSION_READ,
        target(binding),
      )) as NativeSessionReadResult;
      checkedSession(existing.session, binding);
      let receipt: NativeSessionSendResult | undefined = existing.commands.find(
        (command) => command.commandId === binding.commandId,
      );
      if (!receipt) {
        const { resolveWorkerDispatchPrompt } = await import('../worker-prompt.js');
        const taskPrompt =
          input.initialPrompt ??
          (await resolveWorkerDispatchPrompt(vars.projectName, {
            taskFile: input.taskFile,
            taskDir: path.posix.dirname(input.taskFile),
          }));
        const prompt =
          input.initialPrompt ??
          `First run ${shellQuote(path.posix.join(path.posix.dirname(input.taskFile), 'mark'))} start to begin this task's signal attempt.\n\n${taskPrompt}`;
        await save(binding, {
          promptDeliveryStartedAt: context.promptDeliveryStartedAt ?? new Date().toISOString(),
        });
        await admission();
        receipt = (await routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_SEND, {
          ...target(binding),
          generation: binding.generation,
          leaseId: binding.leaseId,
          commandId: binding.commandId,
          text: prompt,
        })) as NativeSessionSendResult;
      }
      if (receipt.commandId !== binding.commandId)
        throw new Error('Native worker returned another command receipt');
      const deadline = Date.now() + RUNNER_LAUNCH_READY_TIMEOUT_MS;
      while (!receipt.accepted) {
        if (receipt.state === 'failed' || Date.now() >= deadline)
          throw new Error('Native worker prompt acceptance is unconfirmed');
        await new Promise((resolve) => setTimeout(resolve, 150));
        const snapshot = (await routeNativeExecution(
          binding.ownerPrincipalId,
          Methods.NATIVE_SESSION_READ,
          target(binding),
        )) as NativeSessionReadResult;
        checkedSession(snapshot.session, binding);
        const command = snapshot.commands.find((item) => item.commandId === binding.commandId);
        if (command) receipt = command;
        if (['closed', 'failed'].includes(snapshot.session.state) && !receipt.accepted)
          throw new Error('Native worker stopped before accepting its task');
      }
    } catch (error) {
      throw new NativeWorkerOperationUncertainError(
        'delivery',
        `Native worker task acceptance is unconfirmed: ${(error as Error).message}`,
        error,
      );
    }
  }
  await admission();
  const working = await save(
    { ...binding, acceptedAt: binding.acceptedAt ?? new Date().toISOString() },
    { status: 'working' },
  );
  if (input.role === primaryRoleForFlow(run.flowType)) {
    const latest = checkRun();
    updateRun(run.id, {
      effort: prepared.launch.effort,
      metrics: {
        ...latest.metrics,
        runner: input.runner,
        model: input.model,
        runnerSessionId: info.nativeSessionId,
        runnerSessionPath: null,
        ...(prepared.accountLabel ? { providerAccountLabel: prepared.accountLabel } : {}),
      },
    });
    await persistRunNow(ownedRun(run.id), 'native worker accepted');
  }
  await withRunTransition(run.id, async () => {
    await admission();
    const applied = await updateSlotStatusIf(
      vars.slotId,
      (slot) => {
        checkRun();
        const current = getRun(run.id)?.agentContexts?.find(
          (item) => item.id === contextId,
        )?.nativeSession;
        return (
          slot.current_run_id === run.id &&
          slot.phase !== 'releasing' &&
          current?.leaseId === binding.leaseId &&
          current.generation === binding.generation &&
          !current.closedAt &&
          !current.releasedAt
        );
      },
      { lifecycle: 'busy', phase: 'working', agent: 'working' },
    );
    if (!applied) throw new Error('Native worker slot ownership changed during settlement');
    await watchContext(vars.slotId, working, { assertCurrent: admission });
    await admission();
    input.emit('dispatch.done', {
      slotId: vars.slotId,
      taskId: input.taskId,
      runner: input.runner,
      model: input.model,
    });
  });
  return { dispatched: true };
}
