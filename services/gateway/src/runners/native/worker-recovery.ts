import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { NATIVE_WORKER_RESUME, NATIVE_WORKER_SEND } from '@farmslot/agent-runtime/native';
import {
  type NativeWorkerLaunch,
  nativeWorkerLaunchDigest,
} from '@farmslot/agent-runtime/native/worker-launch';
import {
  isTerminalRunStatus,
  Methods,
  nativeProfileSessionParams,
  type NativeSessionInfo,
  type NativeSessionReadResult,
  type NativeSessionSendResult,
  type NativeWorkerSessionBinding,
  primaryRoleForFlow,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import { selectAgentContext, upsertAgentContext } from '../../agents/contexts.js';
import { resolveNativeContext } from '../../agents/native-context.js';
import { isLocal, loadProjectVars, loadSlotVars, readSlotRow } from '../../core/index.js';
import { acquireNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
import { slotRealpath } from '../../core/slot-io.js';
import { shellQuote } from '../../core/tmux.js';
import { isNodeTransportUnavailableError } from '../../fleet/node-rpc.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { runTaskLibraries } from '../../tasks/pinned-libraries.js';
import { normalizeWorkerSignal } from '../../tasks/worker-signals.js';
import { RUNNER_LAUNCH_READY_TIMEOUT_MS } from '../launch-command.js';

import { routeNativeExecution } from './node.js';
import { assertNativeWorkerSnapshot, nativeWorkerLiveStatus } from './worker-control.js';
import { NativeWorkerOperationUncertainError } from './worker-error.js';
import { prepareNativeWorkerLaunch } from './worker-launch.js';

/** Run Resume preserves a live worker; a stopped worker resumes its exact saved conversation. */
export async function resumeNativeWorker(
  runId: string,
  options?:
    | {
        purpose: 'parking';
        relocation?: { fromCwd: string };
        contextId: string;
        commandId: string;
        text: string;
        assertCurrent: () => void;
      }
    | { purpose: 'blocked-worker'; commandId: string; assertCurrent: () => void }
    | {
        purpose: 'handoff';
        contextId: string;
        assertCurrent: () => void;
        /** The transfer already validated this exact launch against its recorded digest. */
        launch?: NativeWorkerLaunch;
      }
    | { purpose: 'review-fix'; assertCurrent?: () => void }
    | {
        purpose: 'operator-message';
        contextId: string;
        commandId: string;
        text: string;
        assertCurrent: () => void;
      }
    | {
        purpose: 'review';
        contextId: string;
        text: string;
        commandId?: string;
        assertCurrent?: () => void;
      },
): Promise<void> {
  const slotId = getRun(runId)?.slotId;
  if (!slotId) throw new Error('Native worker recovery requires its owned slot');
  const release = acquireNativeWorkerRecovery(slotId);
  try {
    await resumeNativeWorkerExclusive(runId, options);
  } finally {
    release();
  }
}

async function resumeNativeWorkerExclusive(
  runId: string,
  options: Parameters<typeof resumeNativeWorker>[1],
): Promise<void> {
  options?.assertCurrent?.();
  // Store writes mutate the run in place; recovery must retain its admission identity.
  const run = structuredClone(getRun(runId));
  // A tmux or default run owns no native worker except its native reviewer, which a
  // review relaunch or a WARM handoff of a stopped reviewer resumes (worker-control.ts
  // applies the same rule by role).
  const resumesReviewer =
    options !== undefined &&
    'contextId' in options &&
    Boolean(
      run?.agentContexts?.some(
        (context) => context.id === options.contextId && context.role === 'review',
      ),
    );
  if (
    !run ||
    (run.transport !== 'native' && options?.purpose !== 'review' && !resumesReviewer) ||
    isTerminalRunStatus(run.status) ||
    (!options && run.status !== 'paused') ||
    (options?.purpose === 'blocked-worker' && run.status !== 'blocked') ||
    !run.slotId
  )
    throw new Error('Native worker recovery requires a paused run with its owned slot');
  assertNativeRunOwner(run);
  const slotId = run.slotId;
  const context = selectAgentContext(
    run,
    options?.purpose === 'review' ||
      options?.purpose === 'handoff' ||
      options?.purpose === 'parking' ||
      options?.purpose === 'operator-message'
      ? { contextId: options.contextId }
      : { role: primaryRoleForFlow(run.flowType) },
  );
  if (options?.purpose === 'review' && context?.role !== 'review')
    throw new Error('Native reviewer recovery requires its exact reviewer context');
  const completion = options?.purpose === 'review' && options.commandId ? options : null;
  if (completion && run.status === 'paused')
    throw new Error('Native reviewer completion cannot continue a paused run');
  if (
    completion &&
    (context?.nativeCommandId !== completion.commandId ||
      context?.nativeCommandText !== completion.text)
  )
    throw new Error('Native reviewer completion instruction changed');
  const fix = selectAgentContext(run, { role: 'review-fix' });
  const activeFix =
    options?.purpose !== 'review' &&
    fix?.status === 'working' &&
    fix.taskFile === run.activeTaskFile
      ? fix
      : null;
  if (activeFix && resolveNativeContext(run, activeFix)?.owner.id !== context?.id)
    throw new Error('Active native fix no longer owns this worker');
  if (activeFix && !activeFix.nativeCommandText)
    throw new Error('Active native fix has no materialized instruction');
  let binding = context?.nativeSession;
  if (
    !context ||
    !binding?.generation ||
    binding.releasedAt ||
    (!binding.acceptedAt && options?.purpose !== 'handoff') ||
    !context.runnerSessionId ||
    !context.runner ||
    !context.model ||
    !context.taskFile ||
    !binding.launchDigest ||
    !binding.safetyTier
  )
    throw new Error(
      'Native worker recovery requires its original task, accepted command and launch settings',
    );
  if (
    options?.purpose === 'handoff' &&
    (!binding.handoffFrom || !binding.handoffCompletedAt || binding.acceptedAt)
  )
    throw new Error(
      'Saved worker handoff requires a completed lease transfer before initial task delivery',
    );
  if (binding.handoffFrom && !binding.handoffCompletedAt)
    throw new Error('Reconcile the native task transfer before resuming monitoring');
  const sessionTarget = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
  const read = async () =>
    (await routeNativeExecution(binding!.ownerPrincipalId, Methods.NATIVE_SESSION_READ, {
      ...sessionTarget,
      limit: 1,
    })) as NativeSessionReadResult;
  const assertRunCurrent = () => {
    options?.assertCurrent?.();
    const current = getRun(runId);
    const currentContext = current?.agentContexts?.find((item) => item.id === context.id);
    const currentBinding = currentContext?.nativeSession;
    if (
      completion &&
      (currentContext?.nativeCommandId !== completion.commandId ||
        currentContext?.nativeCommandText !== completion.text)
    )
      throw new Error('Native reviewer completion instruction changed');
    if (
      !current ||
      current.status !== run.status ||
      current.engineState?.generation !== run.engineState?.generation ||
      current.activeTaskFile !== run.activeTaskFile ||
      current.taskFile !== run.taskFile ||
      current.branch !== run.branch ||
      current.slotId !== slotId ||
      currentBinding?.sessionId !== binding!.sessionId ||
      currentBinding.leaseId !== binding!.leaseId ||
      currentBinding.generation !== binding!.generation ||
      currentBinding.releasedAt
    )
      throw new Error('Native worker recovery ownership changed');
    assertNativeRunOwner(current);
  };
  const admit = async () => {
    const slot = await readSlotRow(slotId);
    assertRunCurrent();
    if (slot?.current_run_id !== runId || slot.phase === 'releasing')
      throw new Error('Native worker recovery ownership changed');
  };
  const save = async (patch: Partial<NativeWorkerSessionBinding>) => {
    await admit();
    const saved = await upsertAgentContext(
      runId,
      context.role,
      { id: context.id },
      {
        mirrorIf: (slot) => slot.current_run_id === runId,
        resolvePatch: (latest) => {
          assertRunCurrent();
          if (
            !latest?.nativeSession ||
            latest.nativeSession.generation !== binding!.generation ||
            latest.nativeSession.leaseId !== binding!.leaseId ||
            latest.nativeSession.releasedAt
          )
            throw new Error('Native worker recovery binding changed');
          return { nativeSession: { ...latest.nativeSession, ...patch }, target: null };
        },
      },
    );
    binding = structuredClone(saved!.nativeSession!);
    await persistRunNow(getRun(runId)!, 'native worker recovery');
  };
  await admit();
  let snapshot = await read();
  await admit();
  const verify = (info: NativeSessionInfo) => {
    assertNativeWorkerSnapshot(
      { ...binding!, generation: info.generation },
      { ...snapshot, session: info },
    );
    if (info.nativeSessionId !== context.runnerSessionId)
      throw new Error('Native recovery returned a different saved conversation');
    if (
      info.generation !== binding!.generation &&
      binding!.recovery?.fromGeneration !== binding!.generation
    )
      throw new Error('Native worker generation changed without a recorded recovery intent');
  };
  verify(snapshot.session);
  if (completion && snapshot.session.processStopped && !snapshot.session.capabilities.resume)
    throw new Error('Native reviewer completion cannot resume this saved conversation');
  const monitorOutputs = run.steps.find((step) => step.name === 'monitor')?.outputs;
  const heldSignal = normalizeWorkerSignal(monitorOutputs?.workerSignal);
  const continueHeld =
    !options &&
    monitorOutputs?.reason === 'interactive-worker-operator-owned' &&
    heldSignal.ok &&
    ['blocked', 'failed'].includes(heldSignal.signal.status);
  const continueLive =
    (continueHeld || Boolean(completion) || options?.purpose === 'operator-message') &&
    snapshot.session.state === 'idle' &&
    !snapshot.session.processStopped;
  const explicitCommandId =
    completion?.commandId ??
    (options?.purpose === 'blocked-worker' ||
    options?.purpose === 'parking' ||
    options?.purpose === 'operator-message'
      ? options.commandId
      : undefined);
  if (explicitCommandId) {
    const commandId = explicitCommandId;
    if (binding.recovery && binding.recovery.commandId !== commandId)
      throw new Error('Another native worker recovery must be reconciled first');
    const receipt = snapshot.commands.find((command) => command.commandId === commandId);
    if (receipt?.accepted) {
      if (completion)
        await save({
          recovery: undefined,
          commandId: completion.commandId,
          generation: snapshot.session.generation,
          acceptedAt: binding.recovery?.requestedAt ?? binding.acceptedAt,
          closedAt: snapshot.session.processStopped ? new Date().toISOString() : undefined,
        });
      else if (binding.recovery) await save({ recovery: undefined });
      return;
    }
    if (
      options?.purpose === 'blocked-worker' &&
      !binding.recovery &&
      !snapshot.session.processStopped
    )
      throw new Error(
        ['closed', 'failed'].includes(snapshot.session.state)
          ? `Native worker cleanup is unconfirmed. Verify that its descendants have stopped, then run farmslot run resume ${runId} --confirm-stopped`
          : 'Native worker is still running; use its input controls to continue',
      );
  }
  if (!binding.recovery && nativeWorkerLiveStatus(snapshot) === 'working' && !continueLive) {
    if (options?.purpose === 'parking')
      throw new Error('Live parked worker has no continuation receipt or recovery intent');
    return;
  }
  if (
    binding.recovery?.continueLive &&
    snapshot.session.processStopped &&
    ['closed', 'failed'].includes(snapshot.session.state)
  ) {
    const receipt = snapshot.commands.find(
      (command) => command.commandId === binding!.recovery!.commandId,
    );
    if (receipt?.accepted) {
      // Reconcile the accepted continuation once. Monitoring consumes its fresh
      // terminal signal or presents the stopped-worker recovery decision.
      await save({ recovery: undefined });
      return;
    }
    // The process died before delivery. Recover its saved conversation with the
    // same command ID; an uncertain existing receipt still prevents resending.
    await save({ recovery: { ...binding.recovery, continueLive: undefined } });
  }
  if (!binding.recovery) {
    if (
      !continueLive &&
      (!['closed', 'failed'].includes(snapshot.session.state) || !snapshot.session.processStopped)
    )
      throw new Error(
        'Native worker cleanup is unconfirmed; recovery cannot launch another process',
      );
    await save({
      recovery: {
        fromGeneration: binding.generation!,
        ...(completion ? { requestedAt: new Date().toISOString() } : {}),
        commandId: continueHeld
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  runId,
                  context.id,
                  binding.leaseId,
                  binding.recoveryEpoch ?? 0,
                  heldSignal.signal,
                ]),
              )
              .digest('hex')
          : options?.purpose === 'blocked-worker' ||
              options?.purpose === 'parking' ||
              options?.purpose === 'operator-message'
            ? options.commandId
            : options?.purpose === 'handoff'
              ? binding.commandId
              : (completion?.commandId ?? randomUUID()),
        ...(continueLive ? { continueLive: true } : {}),
        ...(continueHeld
          ? {
              text: `First run ${shellQuote(path.posix.join(path.posix.dirname(context.taskFile), 'mark'))} start to begin a fresh signal attempt. Continue the current task in ${context.taskFile}. Preserve completed work and do not repeat completed steps.`,
            }
          : {}),
        ...(options?.purpose === 'review' ||
        options?.purpose === 'parking' ||
        options?.purpose === 'operator-message'
          ? { text: options.text }
          : activeFix
            ? {
                contextId: activeFix.id,
                text: `${activeFix.nativeCommandText}\nContinue this fix pass. Preserve completed work and do not repeat completed steps.`,
              }
            : options?.purpose === 'review-fix' || options?.purpose === 'handoff'
              ? { resumeOnly: true }
              : {}),
      },
    });
  }
  const intent = binding.recovery!;
  const rawVars = await loadSlotVars(slotId);
  const vars = { ...rawVars, remoteRepo: await slotRealpath(rawVars, rawVars.remoteRepo) };
  if ((isLocal(vars.host, vars.machine) ? 'local' : vars.machine) !== binding.executionNodeId)
    throw new Error('Native recovery execution node changed');
  const projectVars = await loadProjectVars(run.project);
  const prepared =
    options?.purpose === 'handoff' && options.launch
      ? { launch: options.launch }
      : await prepareNativeWorkerLaunch({
          role: context.role,
          reviewValidationDepth: context.reviewValidationDepth,
          vars,
          taskLibraries: runTaskLibraries(run),
          project: projectVars.projectJson,
          projectVars,
          runner: context.runner,
          model: context.model,
          taskDir: path.posix.dirname(context.taskFile),
          sessionId: binding.sessionId,
          leaseId: binding.leaseId,
          effort: binding.effort ?? 'auto',
          safetyTier: binding.safetyTier!,
          accountLabel: binding.accountLabel,
          profile: binding.profile,
          stateDirectory: binding.stateDirectory,
          prepareAccount: false,
          domain: resolveEffectiveDomain(run.domain, vars.domain),
        });
  if (
    prepared.launch.leaseId !== binding.leaseId ||
    nativeWorkerLaunchDigest(prepared.launch) !== binding.launchDigest ||
    (snapshot.session.cwd !== vars.remoteRepo &&
      !(
        options?.purpose === 'parking' &&
        options.relocation?.fromCwd === snapshot.session.cwd &&
        binding.stateDirectory
      ))
  )
    throw new Error('Native recovery launch settings changed; restart the task explicitly');
  if (snapshot.session.generation === intent.fromGeneration && !intent.continueLive) {
    if (!snapshot.session.processStopped)
      throw new Error('Previous native process has not confirmed cleanup');
    const { admitWorkerLaunch } =
      context.role === 'review'
        ? { admitWorkerLaunch: null }
        : await import('../../run-engine/worker-launch-preflight.js');
    const assertPreflightCurrent = !admitWorkerLaunch
      ? async () => {}
      : await admitWorkerLaunch({
          runId,
          vars,
          environment: prepared.launch.environment,
          assertCurrent: assertRunCurrent,
        });
    const { enforceDispatchPressureGate } = await import('../../methods/dispatch/execute.js');
    await enforceDispatchPressureGate({
      machine: vars.machine,
      runId,
      run,
      attemptKey: `native-resume:${runId}:${intent.commandId}`,
      deps: {
        persistRun: async (id, patch) => {
          assertRunCurrent();
          await persistRunNow(updateRun(id, patch), 'native resume pressure admission');
        },
      },
    });
    await admit();
    await save({
      recovery: { ...intent, requestedAt: intent.requestedAt ?? new Date().toISOString() },
    });
    await admit();
    await assertPreflightCurrent();
    const resumeParams = {
      ...sessionTarget,
      ...nativeProfileSessionParams(binding.profile),
      generation: intent.fromGeneration,
      commandId: intent.commandId,
      resumeSessionId: context.runnerSessionId,
      runner: context.runner,
      model: context.model,
      resultSchema: binding.resultSchema,
      cwd: vars.remoteRepo,
      launch: prepared.launch,
      ...(options?.purpose === 'parking' && options.relocation
        ? { relocation: options.relocation }
        : {}),
    };
    let resumed: { session: NativeSessionInfo };
    try {
      resumed = (await routeNativeExecution(
        binding.ownerPrincipalId,
        NATIVE_WORKER_RESUME,
        resumeParams,
      )) as { session: NativeSessionInfo };
    } catch (error) {
      if (completion && isNodeTransportUnavailableError(error))
        throw new NativeWorkerOperationUncertainError(
          'launch',
          'Native reviewer completion resume is unconfirmed; reconcile its reserved command',
          error,
        );
      throw error;
    }
    verify(resumed.session);
    snapshot = { ...snapshot, session: resumed.session };
  }
  if (snapshot.session.generation === intent.fromGeneration && !intent.continueLive)
    throw new Error('Native recovery did not establish a new process generation');
  if (snapshot.session.generation !== binding.generation)
    await save({
      generation: snapshot.session.generation,
      closedAt: snapshot.session.processStopped ? new Date().toISOString() : undefined,
    });
  if (
    !['idle', 'running', 'waiting'].includes(snapshot.session.state) ||
    snapshot.session.processStopped
  )
    throw new Error(
      'Native recovery has not produced a live session; inspect its recorded state before retrying',
    );
  await admit();
  if (intent.resumeOnly) {
    await save({ recovery: undefined });
    return;
  }
  const sendParams = {
    ...sessionTarget,
    generation: binding.generation,
    leaseId: binding.leaseId,
    commandId: intent.commandId,
    text:
      intent.text ??
      `Continue the current task in ${context.taskFile}. Preserve completed work and do not repeat completed steps.`,
  };
  const ownerId = binding.ownerPrincipalId;
  const send = () =>
    routeNativeExecution(
      ownerId,
      NATIVE_WORKER_SEND,
      sendParams,
    ) as Promise<NativeSessionSendResult>;
  let result: NativeSessionSendResult;
  try {
    result = await send();
  } catch (error) {
    if (completion)
      throw new NativeWorkerOperationUncertainError(
        'delivery',
        'Native reviewer completion acceptance is unconfirmed',
        error,
      );
    throw error;
  }
  if (result.commandId !== intent.commandId)
    throw new Error('Native recovery returned another command receipt');
  let accepted = result.accepted;
  const deadline = Date.now() + RUNNER_LAUNCH_READY_TIMEOUT_MS;
  while (!accepted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    snapshot = await read();
    assertNativeWorkerSnapshot(binding, snapshot);
    const receipt = snapshot.commands.find((command) => command.commandId === intent.commandId);
    if (receipt?.state === 'failed')
      throw new Error('Native continuation failed before acceptance');
    accepted = receipt?.accepted === true;
  }
  if (!accepted && completion)
    throw new NativeWorkerOperationUncertainError(
      'delivery',
      'Native reviewer completion acceptance is unconfirmed; reconcile its reserved command',
      undefined,
    );
  if (!accepted)
    throw new Error('Native continuation acceptance is unconfirmed; retry reconciliation');
  if (intent.contextId) {
    await admit();
    await upsertAgentContext(
      runId,
      'review-fix',
      { id: intent.contextId },
      {
        mirrorIf: (slot) => slot.current_run_id === runId,
        resolvePatch: (latest) => {
          assertRunCurrent();
          if (
            !latest ||
            latest.taskFile !== run.activeTaskFile ||
            resolveNativeContext(getRun(runId)!, latest)?.owner.id !== context.id
          )
            throw new Error('Native fix changed during recovery');
          return { nativeCommandId: intent.commandId, nativeCommandText: intent.text };
        },
      },
    );
    await persistRunNow(getRun(runId)!, 'native fix resumed instruction');
  }
  await save({
    recovery: undefined,
    ...(completion ? { acceptedAt: intent.requestedAt ?? new Date().toISOString() } : {}),
    ...(options?.purpose === 'review' ? { commandId: intent.commandId } : {}),
  });
}
