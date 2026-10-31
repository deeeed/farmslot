import { createHash } from 'node:crypto';

import { NATIVE_WORKER_CONFIRM_STOPPED, NATIVE_WORKER_SEND } from '@farmslot/agent-runtime/native';
import {
  type AgentContext,
  type AgentRole,
  isTerminalRunStatus,
  Methods,
  type NativeSessionInfo,
  type NativeSessionReadParams,
  type NativeSessionReadResult,
  type NativeSessionSendResult,
  nativeWorkerBindingIsHeld,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { resolveNativeContext } from '../../agents/native-context.js';
import { readSlotField } from '../../core/index.js';
import { getRun, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';

import { routeNativeExecution } from './node.js';
import { nativeWorkerProfileMatches } from './worker-profile.js';

function workerBinding(
  runId: string,
  role?: AgentRole,
  contextId?: string,
  allowLaunchIntent = false,
) {
  const run = getRun(runId);
  if (!run) throw new Error('Native worker run not found');
  assertNativeRunOwner(run);
  const context = selectAgentContext(run, { role, contextId });
  if (run.transport !== 'native' && context?.role !== 'review')
    throw new Error('Native review control requires its exact review context');
  const binding = resolveNativeContext(run, context)?.binding;
  if (!binding || (!binding.generation && !allowLaunchIntent) || binding.releasedAt)
    throw new Error('Native worker has no current process generation');
  return { run, context, binding };
}

export function assertNativeWorkerSnapshot(
  binding: NativeWorkerSessionBinding,
  snapshot: NativeSessionReadResult,
): void {
  const info = snapshot.session;
  if (
    info.id !== binding.sessionId ||
    info.generation !== binding.generation ||
    info.executionNodeId !== binding.executionNodeId ||
    info.ownerPrincipalId !== binding.ownerPrincipalId ||
    info.workerLeaseId !== binding.leaseId ||
    info.resultSchema !== binding.resultSchema ||
    !nativeWorkerProfileMatches(info, binding)
  )
    throw new Error('Native worker session, generation or task lease changed');
}

/** An idle native conversation is a live worker, not evidence that its task finished. */
export function nativeWorkerLiveStatus(
  snapshot: NativeSessionReadResult,
): 'working' | 'idle' | 'unknown' {
  const info = snapshot.session;
  if (['closed', 'failed'].includes(info.state)) return info.processStopped ? 'idle' : 'unknown';
  if (
    info.processPid &&
    !info.processStopped &&
    ['running', 'waiting', 'idle'].includes(info.state)
  )
    return 'working';
  return 'unknown';
}

export async function readNativeWorkerSnapshot(
  runId: string,
  role?: AgentRole,
  contextId?: string,
  history: Pick<NativeSessionReadParams, 'after' | 'limit'> = {},
) {
  const { binding } = workerBinding(runId, role, contextId, true);
  const snapshot = (await routeNativeExecution(
    binding.ownerPrincipalId,
    Methods.NATIVE_SESSION_READ,
    {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      after: history.after,
      limit: history.limit ?? 1,
    },
  )) as NativeSessionReadResult;
  const observedGeneration = binding.generation ?? snapshot.session.generation;
  assertNativeWorkerSnapshot({ ...binding, generation: observedGeneration }, snapshot);
  // The RPC may have overlapped a transfer, cancellation or explicit recovery.
  const latest = workerBinding(runId, role, contextId, true).binding;
  assertNativeWorkerSnapshot(
    { ...latest, generation: latest.generation ?? observedGeneration },
    snapshot,
  );
  if (
    snapshot.session.state === 'failed' &&
    snapshot.session.error &&
    !isTerminalRunStatus(getRun(runId)!.status)
  ) {
    const current = getRun(runId)!;
    const message = snapshot.session.error.slice(0, 1000);
    const observed = (item: AgentContext) =>
      item.nativeSession?.sessionId === latest.sessionId &&
      item.nativeSession.generation === latest.generation;
    const own = current.agentContexts?.find(observed);
    // A failure a relaunch has taken over, or one after its context finished, stays on its own
    // context, not on the run.
    const runError = own && workerFailureSettled(current, own) ? current.error : message;
    if (
      current.error !== runError ||
      current.agentContexts?.some((item) => observed(item) && item.error !== message)
    )
      updateRun(runId, {
        error: runError,
        agentContexts: current.agentContexts?.map((item) =>
          observed(item) ? { ...item, error: message } : item,
        ),
      });
  }
  return snapshot;
}

/** Read the normalized error for the exact failed command, including earlier event pages. */
export async function readNativeWorkerCommandError(
  runId: string,
  role: AgentRole,
  contextId: string,
  read = readNativeWorkerSnapshot,
): Promise<Error | undefined> {
  const { binding } = workerBinding(runId, role, contextId);
  const commandId = binding.commandId;
  let after: number | undefined;
  let failure: Error | undefined;
  while (true) {
    const snapshot = await read(runId, role, contextId, { after, limit: 500 });
    if (workerBinding(runId, role, contextId).binding.commandId !== commandId)
      throw new Error('Native worker command changed during failure observation');
    for (const event of snapshot.events) {
      if (
        event.sessionId === binding.sessionId &&
        event.generation === binding.generation &&
        event.commandId === commandId &&
        event.type === 'error' &&
        event.text
      )
        failure = new Error(event.text, { cause: event.data });
    }
    if (!snapshot.hasMore) return failure;
    if (snapshot.cursor <= (after ?? 0))
      throw new Error('Native worker failure history cursor did not advance');
    after = snapshot.cursor;
  }
}

/** Later native workers of the same role that accepted their task. */
function laterAcceptedWorkers(run: Run, context: AgentContext): AgentContext[] {
  const contexts = run.agentContexts ?? [];
  const index = contexts.indexOf(context);
  return index < 0
    ? []
    : contexts
        .slice(index + 1)
        .filter((item) => item.nativeSession?.acceptedAt && item.role === context.role);
}

/** A later native worker of the same role, runner and review accepted its task, taking over. */
function workerContextSuperseded(run: Run, context: AgentContext): boolean {
  return laterAcceptedWorkers(run, context).some(
    (item) => item.runner === context.runner && item.reviewId === context.reviewId,
  );
}

/** The context finished, or a relaunch took it over: its later failure is not the run's. */
function workerFailureSettled(run: Run, context: AgentContext): boolean {
  return context.status === 'complete' || workerContextSuperseded(run, context);
}

/**
 * Clear a run.error that only settled native workers carry: a finished worker or reviewer whose
 * host stopped later, or one a running relaunch took over. A closed session's old failure does
 * not keep it once a later worker of its role accepted a task. Any other run.error stays.
 */
export function clearSettledWorkerError(runId: string): void {
  const run = getRun(runId);
  const carriers = run?.error
    ? (run.agentContexts ?? []).filter((item) => item.nativeSession && item.error === run.error)
    : [];
  const settled = (item: AgentContext) =>
    workerFailureSettled(run!, item) ||
    (!nativeWorkerBindingIsHeld(item.nativeSession!) &&
      laterAcceptedWorkers(run!, item).length > 0);
  if (carriers.some((item) => workerFailureSettled(run!, item)) && carriers.every(settled))
    updateRun(runId, { error: undefined });
}

export async function confirmNativeWorkerStopped(runId: string, contextId?: string): Promise<void> {
  const { binding } = workerBinding(runId, undefined, contextId);
  const snapshot = await readNativeWorkerSnapshot(runId, undefined, contextId);
  if (snapshot.session.processStopped) return;
  const result = (await routeNativeExecution(
    binding.ownerPrincipalId,
    NATIVE_WORKER_CONFIRM_STOPPED,
    {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      generation: binding.generation,
      leaseId: binding.leaseId,
    },
  )) as { session: NativeSessionInfo };
  assertNativeWorkerSnapshot(workerBinding(runId, undefined, contextId).binding, {
    ...snapshot,
    session: result.session,
  });
  if (!result.session.processStopped) throw new Error('Native stop confirmation was not recorded');
}

export function nativeWorkerInstructionCommandId(
  runId: string,
  binding: NativeWorkerSessionBinding,
  key: string,
  text: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([runId, binding.sessionId, binding.leaseId, key, text]))
    .digest('hex');
}

/** Completion feedback reaches the worker under its decision's send-back key. */
export function completionSendBackCommandId(decisionId: string): string {
  return `completion-send-back:${decisionId}`;
}

/** Either ID above: Farmslot derived it, and its clients never generate that shape. */
export function isNativeWorkerInstructionCommandId(commandId: string): boolean {
  return /^[0-9a-f]{64}$/.test(commandId) || commandId.startsWith('completion-send-back:');
}

export async function sendNativeWorkerInstruction(input: {
  runId: string;
  slotId: string;
  role?: AgentRole;
  contextId?: string;
  /** Stable logical instruction identity, e.g. monitor nudge count or budget warning. */
  key: string;
  text: string;
  /** Persisted subtask command; otherwise derived from the logical instruction key. */
  commandId?: string;
  /** Existing authenticated command identity retained by an operator's client. */
  logicalCommandId?: string;
  /** Self-review fix policy may execute at an operator gate. */
  allowOperatorWait?: boolean;
  /** Explicit operator messages may enter the host's supported command queue. */
  allowBusyQueue?: boolean;
  assertCurrent?: () => void;
}): Promise<'confirmed' | 'attempted' | 'queued' | 'not-attempted'> {
  input.assertCurrent?.();
  const { run, context, binding } = workerBinding(input.runId, input.role, input.contextId);
  const assertInstruction = (selected: typeof context) => {
    if (
      input.commandId &&
      (selected?.nativeCommandId !== input.commandId || selected.nativeCommandText !== input.text)
    )
      throw new Error('Native subtask instruction changed');
  };
  assertInstruction(context);
  const allowOperatorWait = input.allowOperatorWait && context?.role === 'review-fix';
  if (
    run.slotId !== input.slotId ||
    isTerminalRunStatus(run.status) ||
    (!allowOperatorWait && ['paused', 'blocked'].includes(run.status)) ||
    binding.closedAt
  )
    return 'not-attempted';
  // Derivation from the persisted task lease survives gateway restart without another
  // reservation store. A retry of this instruction always uses the same native command.
  const commandId =
    input.commandId ??
    input.logicalCommandId ??
    nativeWorkerInstructionCommandId(run.id, binding, input.key, input.text);
  const snapshot = await readNativeWorkerSnapshot(run.id, input.role, input.contextId);
  const receipt = snapshot.commands.find((command) => command.commandId === commandId);
  if (receipt?.accepted && !input.logicalCommandId) return 'confirmed';
  if (
    !receipt &&
    ((!input.allowBusyQueue && snapshot.session.state !== 'idle') ||
      snapshot.pendingRequests.length)
  )
    return 'not-attempted';
  if ((await readSlotField(input.slotId, 'current_run_id')) !== run.id) return 'not-attempted';
  const latest = workerBinding(run.id, input.role, input.contextId);
  input.assertCurrent?.();
  assertInstruction(latest.context);
  assertNativeWorkerSnapshot(latest.binding, snapshot);
  if (
    latest.binding.closedAt ||
    isTerminalRunStatus(latest.run.status) ||
    (!allowOperatorWait && ['paused', 'blocked'].includes(latest.run.status))
  )
    return 'not-attempted';
  const result = (await routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_SEND, {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    generation: binding.generation,
    leaseId: binding.leaseId,
    commandId,
    text: input.text,
  })) as NativeSessionSendResult;
  if (result.commandId !== commandId)
    throw new Error('Native instruction returned another command receipt');
  return result.queued ? 'queued' : result.accepted ? 'confirmed' : 'attempted';
}
