import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_METHODS,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_STATE,
  NATIVE_WORKER_TRANSFER,
} from '@farmslot/agent-runtime/native';
import { NATIVE_PROFILE_METHODS } from '@farmslot/agent-runtime/native/profile-service';
import { routeNativeSession } from '@farmslot/agent-runtime/native/service';
import { routeNativeWorkerSession } from '@farmslot/agent-runtime/native/worker-service';
import {
  Methods,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { getAllNodes, getNode } from '../../fleet/machine-registry.js';
import { sendNodeRequest } from '../../fleet/node-rpc.js';
import { loadCredentialStore } from '../../security/credential-store.js';
import { nativeOwnerAssignedMachines } from '../../security/native-node.js';
import { ownsLocalNativeProfile } from '../../security/native-owner.js';

import { knownNativeExecutionNodes } from './execution-nodes.js';
import { nativeSessionManager, validateNativeRunner } from './manager.js';

export async function routeNativeExecution(
  owner: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const executionNodeId = params.executionNodeId ?? 'local';
  if (typeof executionNodeId !== 'string' || !executionNodeId.trim())
    throw new GatewayMethodError('INVALID_PARAMS', 'executionNodeId must be a nonempty string');
  const worker = NATIVE_WORKER_METHODS.includes(method);
  const needsProfiles = params.profileId !== undefined || NATIVE_PROFILE_METHODS.includes(method);
  if (
    method === NATIVE_WORKER_ENSURE ||
    method === NATIVE_WORKER_RESUME ||
    method === Methods.NATIVE_SESSION_CREATE ||
    method === Methods.NATIVE_SESSION_ENSURE
  ) {
    if (
      typeof params.runner !== 'string' ||
      (params.model !== undefined && typeof params.model !== 'string')
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Expected native runner and model strings');
    validateNativeRunner(params.runner, params.model);
  }
  if (executionNodeId === 'local') {
    if (!ownsLocalNativeProfile(owner))
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native local execution is unavailable for this owner',
      );
    return worker
      ? routeNativeWorkerSession(nativeSessionManager, owner, method, params)
      : routeNativeSession(nativeSessionManager, owner, method, params);
  }
  const node = getNode(executionNodeId);
  if (!node || node.nativeSessions?.ownerPrincipalId !== owner || !node.nativeAuthority?.valid())
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  if (needsProfiles && !node.nativeSessions.supportsProfiles)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Execution node upgrade required for native account profiles',
    );
  if (method === Methods.NATIVE_SESSION_ENSURE && !node.nativeSessions.supportsEnsure)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node upgrade required for idempotent creation; existing sessions remain available',
    );
  if (worker && !node.nativeSessions.supportsWorkers)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node upgrade required for worker launch configuration',
    );
  const result = await sendNodeRequest(
    node,
    'native.session',
    { owner, method, params },
    { timeout: 60_000, requireSameConnection: true },
  );
  if (getNode(executionNodeId) !== node || !node.nativeAuthority.valid())
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node authority changed while awaiting its response',
    );
  if (method === NATIVE_WORKER_STATE) {
    if (
      !result ||
      typeof result !== 'object' ||
      !('stateDirectory' in result) ||
      typeof result.stateDirectory !== 'string' ||
      !result.stateDirectory.startsWith('/')
    )
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid worker state directory',
      );
    return result;
  }
  if (method === NATIVE_WORKER_READ) {
    const page = result as NativeSessionReadResult | undefined;
    const scope = page?.scope;
    if (
      !scope ||
      scope.leaseId !== params.leaseId ||
      page?.session?.workerLeaseId !== params.leaseId ||
      !page.session.workerManaged ||
      !Number.isSafeInteger(scope.startAfter) ||
      scope.startAfter < 0 ||
      !Number.isSafeInteger(scope.endAt) ||
      scope.endAt < scope.startAfter ||
      typeof scope.released !== 'boolean' ||
      !Number.isSafeInteger(page.cursor) ||
      page.cursor < scope.startAfter ||
      page.cursor > scope.endAt ||
      !Array.isArray(page.events) ||
      page.events.some(
        (event) =>
          !event ||
          event.sessionId !== params.sessionId ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= scope.startAfter ||
          event.sequence > scope.endAt,
      ) ||
      !Array.isArray(page.commands) ||
      !Array.isArray(page.pendingRequests) ||
      (scope.released && page.pendingRequests.length)
    )
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid worker history scope',
      );
  }
  const generationChanged =
    method === NATIVE_WORKER_CANCEL &&
    typeof params.resumeCommandId === 'string' &&
    Boolean(params.resumeCommandId) &&
    typeof params.generation === 'string' &&
    result &&
    typeof result === 'object' &&
    'cancelled' in result &&
    result.cancelled === false &&
    'reason' in result &&
    result.reason === 'generation-changed' &&
    'generation' in result &&
    typeof result.generation === 'string' &&
    Boolean(result.generation) &&
    result.generation !== params.generation &&
    !('session' in result);
  if (
    method === NATIVE_WORKER_CANCEL &&
    (!result ||
      typeof result !== 'object' ||
      !('cancelled' in result) ||
      (result.cancelled !== true && !generationChanged) ||
      !('sessionId' in result) ||
      result.sessionId !== params.sessionId ||
      !('leaseId' in result) ||
      result.leaseId !== params.leaseId ||
      (!generationChanged &&
        params.generation !== undefined &&
        (!('generation' in result) || result.generation !== params.generation)))
  )
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native node returned a mismatched worker cancellation',
    );
  const hasSession =
    [
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_READ,
      NATIVE_WORKER_READ,
      Methods.NATIVE_SESSION_CLOSE,
      NATIVE_WORKER_ENSURE,
      NATIVE_WORKER_RESUME,
      NATIVE_WORKER_CLOSE,
      NATIVE_WORKER_TRANSFER,
    ].some((candidate) => candidate === method) ||
    (method === NATIVE_WORKER_CANCEL &&
      Boolean(result && typeof result === 'object' && 'session' in result));
  if (hasSession || method === Methods.NATIVE_SESSION_LIST) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid session response',
      );
    const sessions = hasSession
      ? 'session' in result
        ? [result.session]
        : undefined
      : 'sessions' in result && Array.isArray(result.sessions)
        ? result.sessions
        : undefined;
    if (!sessions)
      throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Native node omitted session identity');
    for (const info of sessions) {
      if (
        !info ||
        typeof info !== 'object' ||
        info.executionNodeId !== executionNodeId ||
        info.ownerPrincipalId !== owner ||
        (params.profileId !== undefined && info.profileId !== params.profileId) ||
        (params.profileId !== undefined && info.accountContextId !== params.accountContextId) ||
        typeof info.id !== 'string' ||
        !info.id.trim() ||
        (hasSession && method !== Methods.NATIVE_SESSION_CREATE && info.id !== params.sessionId)
      )
        throw new GatewayMethodError(
          'NATIVE_SESSION_ERROR',
          'Native node returned a mismatched session identity',
        );
    }
  }
  return result;
}

export async function listNativeExecutions(owner: string): Promise<NativeSessionListResult> {
  const assigned = nativeOwnerAssignedMachines(loadCredentialStore().principals, owner);
  const nodes = [
    ...new Set([
      ...(ownsLocalNativeProfile(owner) ? ['local'] : []),
      ...knownNativeExecutionNodes(owner).filter((machine) => assigned.has(machine)),
      ...getAllNodes()
        .filter((node) => {
          const current = getNode(node.machine);
          return (
            current?.nativeSessions?.ownerPrincipalId === owner && current.nativeAuthority?.valid()
          );
        })
        .map((node) => node.machine),
    ]),
  ];
  const results = await Promise.allSettled(
    nodes.map((executionNodeId) =>
      routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, { executionNodeId }),
    ),
  );
  const sessions: NativeSessionInfo[] = [];
  const unavailableExecutionNodes: NonNullable<
    NativeSessionListResult['unavailableExecutionNodes']
  > = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled')
      sessions.push(...(result.value as NativeSessionListResult).sessions);
    else {
      // Partial inventory is explicit: an offline host must not hide sessions on healthy hosts.
      unavailableExecutionNodes.push({
        executionNodeId: nodes[index],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  return { sessions, unavailableExecutionNodes };
}
