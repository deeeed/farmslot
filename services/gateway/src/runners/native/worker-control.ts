import { createHash } from 'node:crypto';

import { NATIVE_WORKER_SEND } from '@farmslot/agent-runtime/native';
import {
  type AgentRole,
  isTerminalRunStatus,
  Methods,
  type NativeSessionReadResult,
  type NativeSessionSendResult,
  type NativeWorkerSessionBinding,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { resolveNativeContext } from '../../agents/native-context.js';
import { readSlotField } from '../../core/index.js';
import { getRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';

import { routeNativeExecution } from './node.js';
import { nativeWorkerProfileMatches } from './worker-profile.js';

function workerBinding(runId: string, role?: AgentRole, contextId?: string) {
  const run = getRun(runId);
  if (!run || run.transport !== 'native') throw new Error('Native worker run not found');
  assertNativeRunOwner(run);
  const context = selectAgentContext(run, { role, contextId });
  const binding = resolveNativeContext(run, context)?.binding;
  if (!binding?.generation || binding.releasedAt)
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
) {
  const { binding } = workerBinding(runId, role, contextId);
  const snapshot = (await routeNativeExecution(
    binding.ownerPrincipalId,
    Methods.NATIVE_SESSION_READ,
    {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      limit: 1,
    },
  )) as NativeSessionReadResult;
  assertNativeWorkerSnapshot(binding, snapshot);
  // The RPC may have overlapped a transfer, cancellation or explicit recovery.
  const latest = workerBinding(runId, role, contextId).binding;
  assertNativeWorkerSnapshot(latest, snapshot);
  return snapshot;
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
  /** Self-review fix policy may execute at an operator gate. */
  allowOperatorWait?: boolean;
  assertCurrent?: () => void;
}): Promise<'confirmed' | 'attempted' | 'not-attempted'> {
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
  const allowOperatorWait = input.allowOperatorWait && context?.role === 'self-review-fix';
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
    createHash('sha256')
      .update(JSON.stringify([run.id, binding.sessionId, binding.leaseId, input.key, input.text]))
      .digest('hex');
  const snapshot = await readNativeWorkerSnapshot(run.id, input.role, input.contextId);
  const receipt = snapshot.commands.find((command) => command.commandId === commandId);
  if (receipt?.accepted) return 'confirmed';
  if (!receipt && (snapshot.session.state !== 'idle' || snapshot.pendingRequests.length))
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
  return result.accepted ? 'confirmed' : 'attempted';
}
