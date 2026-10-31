import { NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import {
  isTerminalRunStatus,
  Methods,
  type NativeSessionReadResult,
  type NativeWorkerControlTarget,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { getAllRunsWithArchived, getRun } from '../../runs/store.js';
import {
  assertNativeRunOwner,
  resolveReviewWorkspaceOwner,
} from '../../security/native-worker-owner.js';

import { routeNativeExecution } from './node.js';
import { nativeWorkerRecordsAcceptance } from './worker-input.js';

export const NATIVE_WORKER_READ_METHODS: readonly string[] = [
  Methods.NATIVE_SESSION_READ,
  Methods.NATIVE_SESSION_WORKSPACE_LIST,
  Methods.NATIVE_SESSION_WORKSPACE_READ,
  Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
  Methods.NATIVE_SESSION_WORKSPACE_DIFF,
  Methods.NATIVE_SESSION_TURN_DIFF,
];

function readTarget(value: unknown): NativeWorkerControlTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      'Worker history requires its pinned run context',
    );
  const target = value as Record<string, unknown>;
  const keys = ['runId', 'contextId', 'generation', 'leaseId'];
  if (
    Object.keys(target).some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof target[key] !== 'string' || !target[key].trim())
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Invalid pinned worker history target');
  return {
    runId: target.runId as string,
    contextId: target.contextId as string,
    generation: target.generation as string,
    leaseId: target.leaseId as string,
  };
}

/** Historical references resolve only their original owner's recorded attempt. */
export function nativeWorkerHistoryBinding(
  run: Run,
  target: NativeWorkerControlTarget,
): { binding: NativeWorkerSessionBinding; readOnly: boolean } | undefined {
  const contexts = run.agentContexts?.filter((context) => context.id === target.contextId) ?? [];
  if (contexts.length !== 1) return;
  const context = contexts[0];
  if (context.runId !== run.id || (context.nativeSession && context.nativeSessionOwner)) return;
  const reference = context.nativeSessionOwner;
  const owners = reference
    ? (run.agentContexts?.filter((owner) => owner.id === reference.contextId) ?? [])
    : [context];
  if (owners.length !== 1) return;
  const owner = owners[0];
  if (run.transport !== 'native' && (context.role !== 'review' || owner.role !== 'review')) return;
  if (
    owner.nativeSessionOwner ||
    owner.runId !== run.id ||
    owner.slotId !== context.slotId ||
    (reference && owner.id === context.id)
  )
    return;
  const bindings = [owner.nativeSession, ...(owner.nativeSessionHistory ?? [])].filter(
    (binding): binding is NativeWorkerSessionBinding =>
      Boolean(binding) &&
      binding!.leaseId === target.leaseId &&
      binding!.generation === target.generation &&
      (!reference ||
        (binding!.sessionId === reference.sessionId && binding!.leaseId === reference.leaseId)),
  );
  if (bindings.length !== 1) return;
  const binding = bindings[0];
  return {
    binding,
    readOnly:
      binding !== owner.nativeSession ||
      Boolean(run.archivedAt || binding.releasedAt || binding.closedAt) ||
      isTerminalRunStatus(run.status),
  };
}

export async function authorizeNativeWorkerHistory(
  method: string,
  params: Record<string, unknown>,
) {
  const target = readTarget(params.worker);
  const archived = getRun(target.runId)
    ? undefined
    : (await getAllRunsWithArchived()).find((run) => run.id === target.runId);
  const current = () => {
    const run = getRun(target.runId) ?? archived;
    if (!run) throw new GatewayMethodError('NOT_FOUND', 'Native worker run is unavailable');
    assertNativeRunOwner(run);
    const selected = nativeWorkerHistoryBinding(run, target);
    const binding = selected?.binding;
    if (
      !selected ||
      !binding ||
      (run.nativeOwnerPrincipalId !== undefined &&
        binding.ownerPrincipalId !== run.nativeOwnerPrincipalId) ||
      binding.sessionId !== params.sessionId ||
      binding.executionNodeId !== (params.executionNodeId ?? 'local')
    )
      throw new GatewayMethodError('NOT_FOUND', 'Worker history target is unavailable or stale');
    if (method !== Methods.NATIVE_SESSION_READ && (selected.readOnly || binding.recovery))
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Current workspace is unavailable for task history',
      );
    if (run.transport !== 'native') resolveReviewWorkspaceOwner(binding.ownerPrincipalId);
    return { ...selected, run };
  };
  return current();
}

export async function routeNativeWorkerRead(method: string, params: Record<string, unknown>) {
  const target = readTarget(params.worker);
  const current = () => authorizeNativeWorkerHistory(method, params);
  const { binding } = await current();
  const nativeParams = {
    ...params,
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    leaseId: binding.leaseId,
  };
  if (method !== Methods.NATIVE_SESSION_READ) {
    const result = await routeNativeExecution(binding.ownerPrincipalId, method, {
      ...nativeParams,
      worker: target,
    });
    await current();
    return result;
  }
  const result = (await routeNativeExecution(
    binding.ownerPrincipalId,
    NATIVE_WORKER_READ,
    nativeParams,
  )) as NativeSessionReadResult;
  const { run } = await current();
  if (
    !result.scope ||
    result.scope.leaseId !== binding.leaseId ||
    result.session.workerLeaseId !== binding.leaseId ||
    result.session.ownerPrincipalId !== binding.ownerPrincipalId ||
    result.session.id !== binding.sessionId ||
    result.session.executionNodeId !== binding.executionNodeId
  )
    throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Native worker history scope changed');
  const context = run.agentContexts?.find((item) => item.id === target.contextId);
  if (!nativeWorkerRecordsAcceptance(run, context)) return result;
  // Removal and steering are refused here, so a client must not offer them.
  const {
    cancelQueued: _cancelWithheld,
    steer: _steerWithheld,
    ...capabilities
  } = result.session.capabilities;
  return { ...result, session: { ...result.session, capabilities } };
}
