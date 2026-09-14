import { createHash } from 'node:crypto';
import path from 'node:path';

import { nativeWorkerLaunchDigest } from '@farmslot/agent-runtime/native/worker-launch';
import {
  isTerminalRunStatus,
  type MachineParkRecord,
  type MachinePauseNativeRecoveryHandle,
  Methods,
  type NativeSessionReadResult,
  type NativeWorkerSessionBinding,
  primaryRoleForFlow,
  type Run,
  sameNativeProfileReference,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import { selectAgentContext } from '../../agents/contexts.js';
import { execOnSlot } from '../../core/exec.js';
import { isLocal, loadProjectVars, loadSlotVars, readSlotRow } from '../../core/index.js';
import { slotRealpath } from '../../core/slot-io.js';
import { shellQuote } from '../../core/tmux.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { unwatchContext, watchContext } from '../../tasks/watcher.js';
import { runnerSupportsNativeTaskReuse } from '../registry.js';

import { routeNativeExecution } from './node.js';
import { cancelNativeWorkerContext } from './worker.js';
import { nativeWorkerLiveStatus, readNativeWorkerSnapshot } from './worker-control.js';
import { prepareNativeWorkerLaunch } from './worker-launch.js';
import { nativeParkTaskArchive } from './worker-parking-task.js';
import { nativeWorkerProfileMatches } from './worker-profile.js';
import { resumeNativeWorker } from './worker-recovery.js';

type Handle = MachinePauseNativeRecoveryHandle;

function parkingCommand(run: Run, handle: Handle): string {
  if (!run.park || run.park.recoveryHandle?.version !== 2)
    throw new Error('Native parking has no durable recovery handle');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'machine-park',
        run.id,
        run.park.createdAt,
        handle.leaseId,
        handle.generation,
      ]),
    )
    .digest('hex');
}

function currentOwner(runId: string, handle: Handle) {
  const run = getRun(runId);
  if (!run || run.transport !== 'native') throw new Error('Native parked run no longer exists');
  assertNativeRunOwner(run);
  const context = run.agentContexts?.find((item) => item.id === handle.contextId);
  const binding = context?.nativeSession;
  if (
    run.slotId !== handle.slotId ||
    !context ||
    !binding ||
    binding.releasedAt ||
    binding.sessionId !== handle.nativeSessionId ||
    binding.leaseId !== handle.leaseId ||
    binding.ownerPrincipalId !== handle.ownerPrincipalId ||
    binding.launchDigest !== handle.launchDigest ||
    !sameNativeProfileReference(binding.profile, handle.profile) ||
    binding.stateDirectory !== handle.stateDirectory ||
    binding.executionNodeId !== handle.executionNodeId ||
    context.runnerSessionId !== handle.sessionId ||
    context.runner !== handle.runnerId ||
    context.model !== handle.model ||
    !binding.generation
  )
    throw new Error('Native parking session, owner, slot or task lease changed');
  const others = run.agentContexts?.some(
    (item) =>
      item.id !== context.id &&
      item.nativeSession &&
      !item.nativeSession.releasedAt &&
      (!item.nativeSession.closedAt || item.nativeSession.recovery),
  );
  if (others) throw new Error('Native parking requires one owned worker process');
  return { run, context, binding };
}

export async function resolveNativeParkHandle(run: Run): Promise<Handle> {
  assertNativeRunOwner(run);
  if (isTerminalRunStatus(run.status)) throw new Error('Cannot park a terminal native run');
  const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  const binding = context?.nativeSession;
  if (
    !run.slotId ||
    !context ||
    !binding?.generation ||
    binding.recovery ||
    binding.releasedAt ||
    !binding.acceptedAt ||
    !binding.launchDigest ||
    (binding.handoffFrom && !binding.handoffCompletedAt) ||
    !binding.safetyTier ||
    !context.runnerSessionId ||
    !context.runner ||
    !context.model
  )
    throw new Error('Native parking requires an accepted worker with saved launch settings');
  if (!runnerSupportsNativeTaskReuse(context.runner))
    throw new Error('Native runner does not declare saved worker recovery');
  const snapshot = await readNativeWorkerSnapshot(run.id, undefined, context.id);
  if (!snapshot.session.capabilities.resume)
    throw new Error('Native worker session does not support saved conversation recovery');
  const handle: Handle = {
    version: 2,
    transport: 'native',
    runnerId: context.runner,
    contextId: context.id,
    sessionId: context.runnerSessionId,
    nativeSessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    ownerPrincipalId: binding.ownerPrincipalId,
    leaseId: binding.leaseId,
    generation: binding.generation,
    launchDigest: binding.launchDigest,
    ...(binding.profile ? { profile: binding.profile } : {}),
    ...(binding.stateDirectory ? { stateDirectory: binding.stateDirectory } : {}),
    slotId: run.slotId,
    cwd: snapshot.session.cwd,
    model: context.model,
    capturedAt: new Date().toISOString(),
  };
  await inspectNativeParkHandle(run, handle, 'live');
  return handle;
}

/** Plan an explicit same-host move without changing the session, credentials or launch settings. */
export async function rehomeNativeParkHandle(
  run: Run,
  handle: Handle,
  slotId: string,
): Promise<Handle> {
  const owner = currentOwner(run.id, handle);
  if (!handle.stateDirectory)
    throw new Error('Legacy native worker state is workspace-bound; restore in its original slot');
  if (handle.relocation)
    throw new Error('Reconcile the pending native relocation before choosing another slot');
  const snapshot = await inspectNativeParkHandle(run, handle, 'stopped');
  if (!snapshot.session.capabilities.resumeAcrossWorkspaces)
    throw new Error('Installed native runner does not support recovery in a sibling worktree');
  if (!owner.context.taskFile) throw new Error('Native parking task document is missing');
  await nativeParkTaskArchive({
    runSlotId: handle.slotId,
    handle,
    archiveKey: parkingCommand(owner.run, handle),
    taskFile: owner.context.taskFile,
    operation: 'inspect',
  });
  const rawVars = await loadSlotVars(slotId);
  const vars = { ...rawVars, remoteRepo: await slotRealpath(rawVars, rawVars.remoteRepo) };
  if ((isLocal(vars.host, vars.machine) ? 'local' : vars.machine) !== handle.executionNodeId)
    throw new Error('Native parking cannot relocate across execution nodes');
  if (
    [handle.cwd, vars.remoteRepo].some(
      (cwd) => handle.stateDirectory === cwd || handle.stateDirectory!.startsWith(cwd + '/'),
    )
  )
    throw new Error('Native account state must remain outside both slot workspaces');
  const probe = `const fs=require('node:fs'),cp=require('node:child_process');const dirs=JSON.parse(process.argv[1]);const roots=dirs.map(cwd=>fs.realpathSync(cp.execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd,encoding:'utf8'}).trim()));if(roots[0]!==roots[1])throw Error('Native relocation requires sibling worktrees of the same repository');`;
  const siblings = await execOnSlot(
    vars,
    `node -e ${shellQuote(probe)} ${shellQuote(JSON.stringify([handle.cwd, vars.remoteRepo]))}`,
    { timeout: 15_000 },
  );
  if (siblings.exitCode !== 0)
    throw new Error('Native relocation requires sibling worktrees of the same repository');
  const projectVars = await loadProjectVars(run.project);
  const prepared = await prepareNativeWorkerLaunch({
    vars,
    project: projectVars.projectJson,
    projectVars,
    runner: handle.runnerId,
    model: handle.model,
    taskDir: handle.taskBundle
      ? path.posix.join(handle.stateDirectory!, 'parks', parkingCommand(owner.run, handle), 'task')
      : path.posix.resolve(handle.cwd, path.posix.dirname(owner.context.taskFile)),
    sessionId: handle.nativeSessionId,
    leaseId: handle.leaseId,
    effort: owner.binding.effort ?? 'auto',
    safetyTier: owner.binding.safetyTier!,
    accountLabel: owner.binding.accountLabel,
    profile: owner.binding.profile,
    stateDirectory: handle.stateDirectory,
    prepareAccount: false,
    domain: resolveEffectiveDomain(run.domain, vars.domain),
  });
  if (nativeWorkerLaunchDigest(prepared.launch) !== handle.launchDigest)
    throw new Error('Target slot changes the saved native account or launch environment');
  currentOwner(run.id, handle);
  return {
    ...handle,
    slotId,
    cwd: vars.remoteRepo,
    relocation: { fromSlotId: handle.slotId, fromCwd: handle.cwd },
  };
}

/** Restore preflight runs before the slot CAS; inspect the recorded source and proposed destination. */
export async function inspectNativeParkTarget(run: Run, handle: Handle): Promise<void> {
  const current = getRun(run.id);
  if (handle.relocation && current?.slotId !== handle.slotId) {
    const source = current?.park?.recoveryHandle;
    if (!current || source?.version !== 2) throw new Error('Native relocation source changed');
    const planned = await rehomeNativeParkHandle(current, source, handle.slotId);
    if (JSON.stringify(planned) !== JSON.stringify(handle))
      throw new Error('Native relocation plan changed');
    return;
  }
  await inspectNativeParkHandle(run, handle, 'stopped-or-live');
}

/** Directory changes are admitted only by the park's durable relocation handle. */
export async function inspectNativeParkHandle(
  run: Run,
  handle: Handle,
  expected: 'live' | 'stopped' | 'stopped-or-live',
): Promise<NativeSessionReadResult> {
  currentOwner(run.id, handle);
  const vars = await loadSlotVars(handle.slotId);
  if (
    (isLocal(vars.host, vars.machine) ? 'local' : vars.machine) !== handle.executionNodeId ||
    (await slotRealpath(vars, vars.remoteRepo)) !== handle.cwd
  )
    throw new Error(
      'Native parking cannot move the saved conversation to another node or directory',
    );
  const snapshot = (await routeNativeExecution(
    handle.ownerPrincipalId,
    Methods.NATIVE_SESSION_READ,
    {
      sessionId: handle.nativeSessionId,
      executionNodeId: handle.executionNodeId,
      limit: 1,
    },
  )) as NativeSessionReadResult;
  const owner = currentOwner(run.id, handle);
  assertNativeParkSnapshot({
    status: owner.run.status,
    handle,
    binding: owner.binding,
    snapshot,
    commandId: owner.run.park ? parkingCommand(owner.run, handle) : undefined,
  });
  const state = nativeWorkerLiveStatus(snapshot);
  if (
    state === 'unknown' ||
    (expected === 'live' && state !== 'working') ||
    (expected === 'stopped' && state !== 'idle')
  )
    throw new Error(
      `Native parking expected ${expected}; process cleanup or liveness is unconfirmed`,
    );
  return snapshot;
}

/** Recovery may replace only the generation recorded by this park's durable command. */
export function assertNativeParkSnapshot({
  status,
  handle,
  binding,
  snapshot,
  commandId,
}: {
  status: Run['status'];
  handle: Handle;
  binding: NativeWorkerSessionBinding;
  snapshot: NativeSessionReadResult;
  commandId?: string;
}): void {
  const info = snapshot.session;
  const recovery = binding.recovery;
  const recovering = Boolean(commandId && recovery?.commandId === commandId);
  const accepted = Boolean(
    commandId && snapshot.commands.some((item) => item.commandId === commandId && item.accepted),
  );
  // Cancellation may reconcile a resumed generation before its continuation lands.
  // Its exact stopped binding remains observable after the run becomes terminal.
  const cancelledCleanup =
    isTerminalRunStatus(status) &&
    info.processStopped &&
    ['closed', 'failed'].includes(info.state) &&
    info.generation === binding.generation;
  if (
    info.id !== handle.nativeSessionId ||
    info.nativeSessionId !== handle.sessionId ||
    info.ownerPrincipalId !== handle.ownerPrincipalId ||
    info.executionNodeId !== handle.executionNodeId ||
    info.workerLeaseId !== handle.leaseId ||
    !sameNativeProfileReference(binding.profile, handle.profile) ||
    !nativeWorkerProfileMatches(info, binding) ||
    (info.cwd !== handle.cwd &&
      !(
        handle.relocation?.fromCwd === info.cwd &&
        info.generation === handle.generation &&
        info.processStopped &&
        ['closed', 'failed'].includes(info.state)
      )) ||
    (info.generation !== handle.generation && !recovering && !accepted && !cancelledCleanup) ||
    (info.generation !== binding.generation &&
      !(recovering && recovery?.fromGeneration === binding.generation))
  )
    throw new Error('Native parking process identity changed without its recovery intent');
}

export async function stopNativeWorkerForPark(run: Run, handle: Handle): Promise<void> {
  await inspectNativeParkHandle(run, handle, 'stopped-or-live');
  const slot = await readSlotRow(handle.slotId);
  const owner = currentOwner(run.id, handle);
  if (
    isTerminalRunStatus(owner.run.status) ||
    slot?.current_run_id !== run.id ||
    slot.phase === 'releasing' ||
    owner.binding.generation !== handle.generation ||
    owner.binding.recovery
  )
    throw new Error('Native parking stop ownership changed');
  await cancelNativeWorkerContext(run.id, owner.context, { machineTransitionHeld: true });
  await inspectNativeParkHandle(run, handle, 'stopped');
  await unwatchContext(handle.slotId, handle.contextId, { expectedRunId: run.id });
  const taskBundle = await nativeParkTaskArchive({
    runSlotId: handle.slotId,
    handle,
    archiveKey: parkingCommand(owner.run, handle),
    taskFile: owner.context.taskFile,
    operation: 'snapshot',
  });
  if (taskBundle) {
    const latest = currentOwner(run.id, handle).run;
    if (!latest.park) throw new Error('Native park intent disappeared during task preservation');
    const saved = updateRun(run.id, {
      park: { ...latest.park, recoveryHandle: { ...handle, taskBundle } },
    });
    await persistRunNow(saved, 'native parking task archive');
  }
}

export async function reloadNativeWorkerForPark(
  run: Run,
  handle: Handle,
  text: string,
): Promise<NonNullable<MachineParkRecord['recoveryProof']>> {
  const initial = currentOwner(run.id, handle).run;
  const operationId = initial.park?.operationId;
  const generation = initial.engineState?.generation;
  const commandId = parkingCommand(initial, handle);
  const assertCurrent = () => {
    const owner = currentOwner(run.id, handle);
    if (
      isTerminalRunStatus(owner.run.status) ||
      owner.run.park?.operationId !== operationId ||
      owner.run.park?.phase !== 'runner-reloading' ||
      owner.run.engineState?.generation !== generation
    )
      throw new Error('Native parking restore operation changed');
  };
  assertCurrent();
  const before = await inspectNativeParkHandle(initial, handle, 'stopped-or-live');
  if (handle.relocation && before.session.generation === handle.generation) {
    await nativeParkTaskArchive({
      runSlotId: handle.slotId,
      handle,
      archiveKey: commandId,
      operation: 'restore',
    });
    assertCurrent();
  }
  await resumeNativeWorker(run.id, {
    purpose: 'parking',
    contextId: handle.contextId,
    commandId,
    text,
    ...(handle.relocation ? { relocation: { fromCwd: handle.relocation.fromCwd } } : {}),
    assertCurrent,
  });
  const snapshot = await inspectNativeParkHandle(initial, handle, 'live');
  assertCurrent();
  if (!snapshot.commands.some((item) => item.commandId === commandId && item.accepted))
    throw new Error('Native parking continuation has no accepted command receipt');
  await watchContext(handle.slotId, currentOwner(run.id, handle).context);
  assertCurrent();
  return {
    sessionId: handle.sessionId,
    live: true,
    acknowledgement: {
      kind: 'structured',
      source: 'native-command-receipt',
      reason: 'Saved worker accepted its parking continuation',
      turnToken: commandId,
    },
    acceptedAt: new Date().toISOString(),
  };
}
