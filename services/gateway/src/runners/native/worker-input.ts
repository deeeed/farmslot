import {
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_SEND,
} from '@farmslot/agent-runtime/native';
import { isTerminalRunStatus, Methods, type NativeWorkerControlTarget } from '@farmslot/protocol';

import { resolveNativeContext } from '../../agents/native-context.js';
import { readSlotRow } from '../../core/index.js';
import { GatewayMethodError } from '../../core/method-error.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { getRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';

import { routeNativeExecution } from './node.js';
import { cancelReviewWorkspaceWorker } from './review-workspace.js';
import { cancelNativeWorkerContext } from './worker.js';

export const NATIVE_WORKER_INPUT_METHODS: readonly string[] = [
  Methods.NATIVE_SESSION_SEND,
  Methods.NATIVE_SESSION_RESPOND,
  Methods.NATIVE_SESSION_INTERRUPT,
  Methods.NATIVE_SESSION_CLOSE,
];

function workerTarget(value: unknown): NativeWorkerControlTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Worker input requires its pinned run context');
  const target = value as Record<string, unknown>;
  const keys = ['runId', 'contextId', 'generation', 'leaseId'] as const;
  if (
    Object.keys(target).some((key) => !keys.some((allowed) => key === allowed)) ||
    keys.some((key) => typeof target[key] !== 'string' || !target[key].trim())
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Invalid pinned worker input target');
  return {
    runId: target.runId as string,
    contextId: target.contextId as string,
    generation: target.generation as string,
    leaseId: target.leaseId as string,
  };
}

/** Network controls are checked against durable run ownership before the host's lease CAS. */
export async function routeNativeWorkerInput(
  method: string,
  params: Record<string, unknown>,
  emit: (event: string, payload: unknown) => void = () => {},
) {
  const target = workerTarget(params.worker);
  if (method === Methods.NATIVE_SESSION_CLOSE)
    return withRunTransition(target.runId, () =>
      routePinnedWorkerInput(method, params, target, emit),
    );
  return routePinnedWorkerInput(method, params, target, emit);
}

async function routePinnedWorkerInput(
  method: string,
  params: Record<string, unknown>,
  target: NativeWorkerControlTarget,
  emit: (event: string, payload: unknown) => void,
) {
  const current = () => {
    const run = getRun(target.runId);
    if (!run)
      throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Native worker run is unavailable');
    assertNativeRunOwner(run);
    const context = run.agentContexts?.find((context) => context.id === target.contextId);
    const binding = resolveNativeContext(run, context)?.binding;
    if (
      !context ||
      !binding ||
      (run.transport !== 'native' && (context.role !== 'review' || context.nativeSessionOwner)) ||
      (run.nativeOwnerPrincipalId !== undefined &&
        binding.ownerPrincipalId !== run.nativeOwnerPrincipalId) ||
      binding.sessionId !== params.sessionId ||
      binding.executionNodeId !== (params.executionNodeId ?? 'local') ||
      binding.generation !== target.generation ||
      binding.leaseId !== target.leaseId ||
      (binding.closedAt &&
        !(
          method === Methods.NATIVE_SESSION_SEND &&
          run.acceptanceRegistration &&
          context.role !== 'review'
        )) ||
      binding.releasedAt ||
      isTerminalRunStatus(run.status)
    )
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Worker input target is closed, transferred or stale',
      );
    if (method === Methods.NATIVE_SESSION_SEND && !binding.acceptedAt)
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Initial worker task acceptance must be reconciled before sending another instruction',
      );
    if (!run.slotId && (!run.reviewWorkspace || run.reviewWorkspace.cleanedAt))
      throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Worker no longer owns a slot');
    return { run, context, binding, slotId: run.slotId };
  };
  const before = current();
  const slot = before.slotId ? await readSlotRow(before.slotId) : undefined;
  const { run, context, binding, slotId } = current();
  if (
    slotId !== before.slotId ||
    (slotId && (slot?.current_run_id !== run.id || slot.phase === 'releasing'))
  )
    throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Worker slot ownership changed');
  const nativeTarget = {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    generation: target.generation,
    leaseId: target.leaseId,
  };
  if (
    method === Methods.NATIVE_SESSION_SEND &&
    run.acceptanceRegistration &&
    context.role !== 'review' &&
    slotId
  ) {
    if (typeof params.commandId !== 'string' || typeof params.text !== 'string')
      throw new GatewayMethodError('INVALID_PARAMS', 'Worker message requires commandId and text');
    const { operatorMessage } = await import('../../methods/run/operator-message.js');
    const message = await operatorMessage(
      {
        slotId,
        runId: run.id,
        contextId: context.id,
        operatorMessageId: params.commandId,
        text: params.text,
        enter: true,
      },
      emit,
    );
    if (!message)
      throw new GatewayMethodError('INVALID_PARAMS', 'Worker acceptance steering is unavailable');
    return {
      commandId: params.commandId,
      submitted: message.delivery === 'confirmed',
      accepted: message.delivery === 'confirmed',
      queued: message.delivery === 'queued',
      state: message.delivery === 'confirmed' ? 'accepted' : 'pending',
    };
  }
  if (method === Methods.NATIVE_SESSION_SEND)
    return routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_SEND, {
      ...nativeTarget,
      commandId: params.commandId,
      text: params.text,
    });
  if (method === Methods.NATIVE_SESSION_RESPOND)
    return routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_RESPOND, {
      ...nativeTarget,
      requestId: params.requestId,
      response: { decision: params.decision, answers: params.answers },
    });
  if (method === Methods.NATIVE_SESSION_INTERRUPT)
    return routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_INTERRUPT, nativeTarget);
  if (method === Methods.NATIVE_SESSION_CLOSE) {
    if (run.reviewWorkspace) await cancelReviewWorkspaceWorker(run.id);
    else await cancelNativeWorkerContext(run.id, context, { machineTransitionHeld: true });
    const snapshot = (await routeNativeExecution(
      binding.ownerPrincipalId,
      Methods.NATIVE_SESSION_READ,
      nativeTarget,
    )) as { session: unknown };
    return { closed: true, session: snapshot.session };
  }
  throw new GatewayMethodError('INVALID_PARAMS', 'Unsupported worker input method');
}
