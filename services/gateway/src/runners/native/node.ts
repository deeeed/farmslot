import { WebSocket } from 'ws';

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
  type ExecResult,
  Methods,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { type ConnectedNode, getAllNodes, getNode } from '../../fleet/machine-registry.js';
import {
  isNodeTransportUnavailableError,
  NodeTransportUnavailableError,
  sendNodeRequest,
} from '../../fleet/node-rpc.js';
import { loadCredentialStore } from '../../security/credential-store.js';
import { nativeOwnerAssignedMachines } from '../../security/native-node.js';
import { ownsLocalNativeProfile } from '../../security/native-owner.js';

import { knownNativeExecutionNodes } from './execution-nodes.js';
import { nativeSessionManager, validateNativeRunner } from './manager.js';

type AuthorizedNativeNode = ConnectedNode & {
  nativeSessions: NonNullable<ConnectedNode['nativeSessions']>;
  nativeAuthority: NonNullable<ConnectedNode['nativeAuthority']>;
};

function hasIssuedOfflineAssignment(owner: string, machine: string, principalId?: string): boolean {
  const store = loadCredentialStore();
  const nodes = store.principals.filter(
    (principal) => principal.subject.type === 'node' && principal.subject.machine === machine,
  );
  const node = nodes.length === 1 ? nodes[0] : undefined;
  return Boolean(
    store.principals.some(
      (principal) => principal.id === owner && principal.subject.type !== 'node',
    ) &&
    node?.subject.type === 'node' &&
    node.subject.nativeOwnerPrincipalId === owner &&
    (!principalId || node.id === principalId) &&
    store.credentials.some(
      (credential) => credential.principalId === node.id && !credential.revokedAt,
    ),
  );
}

/** An offline assignment permits waiting only; it never authorizes a request without a live node. */
export function resolveNativeExecutionNode(owner: string, machine: string): AuthorizedNativeNode {
  const node = getNode(machine);
  if (!node && hasIssuedOfflineAssignment(owner, machine))
    throw new NodeTransportUnavailableError(
      machine,
      'not-connected',
      'Native execution node is temporarily unavailable',
    );
  if (!node || node.nativeSessions?.ownerPrincipalId !== owner || !node.nativeAuthority)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  if (
    node.ws.readyState !== WebSocket.OPEN &&
    hasIssuedOfflineAssignment(owner, machine, node.nativeAuthority.principalId)
  )
    throw new NodeTransportUnavailableError(
      machine,
      'disconnected',
      'Native execution node connection is unavailable',
    );
  if (!node.nativeAuthority.valid())
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  return node as AuthorizedNativeNode;
}

function assertNativeConnection(
  owner: string,
  machine: string,
  expected: AuthorizedNativeNode,
): void {
  let current: AuthorizedNativeNode;
  try {
    current = resolveNativeExecutionNode(owner, machine);
  } catch (error) {
    if (error instanceof GatewayMethodError)
      throw new GatewayMethodError(
        error.code,
        'Native execution node authority changed while awaiting its response',
      );
    throw error;
  }
  if (current.nativeAuthority.principalId !== expected.nativeAuthority.principalId)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node authority changed while awaiting its response',
    );
  if (current !== expected)
    throw new NodeTransportUnavailableError(
      machine,
      'connection-replaced',
      'Native execution node connection changed while awaiting its response',
    );
}

/** Filesystem helpers use the same native owner and connection checks as worker commands. */
export async function requestNativeNode(
  owner: string,
  machine: string,
  method: string,
  params: unknown,
  timeout: number,
): Promise<unknown> {
  const node = resolveNativeExecutionNode(owner, machine);
  if (!node.nativeSessions.supportsWorkers || !node.nativeSessions.supportsEnsure)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native node does not support owned worker operations',
    );
  let result: unknown;
  try {
    result = await sendNodeRequest(node, method, params, {
      timeout,
      requireSameConnection: true,
    });
  } catch (error) {
    if (isNodeTransportUnavailableError(error)) assertNativeConnection(owner, machine, node);
    throw error;
  }
  assertNativeConnection(owner, machine, node);
  return result;
}

export async function execNativeNodeArgv(
  owner: string,
  machine: string,
  argv: string[],
  timeout: number,
): Promise<ExecResult> {
  return (await requestNativeNode(
    owner,
    machine,
    'exec',
    { argv, timeout },
    timeout + 10_000,
  )) as ExecResult;
}

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
  const node = resolveNativeExecutionNode(owner, executionNodeId);
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
  let result: unknown;
  try {
    result = await sendNodeRequest(
      node,
      'native.session',
      { owner, method, params },
      { timeout: 60_000, requireSameConnection: true },
    );
  } catch (error) {
    // A timeout is retryable only while the same issued owner still has authority.
    // Structured node/protocol failures remain terminal regardless of connection state.
    if (isNodeTransportUnavailableError(error))
      assertNativeConnection(owner, executionNodeId, node);
    throw error;
  }
  assertNativeConnection(owner, executionNodeId, node);
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
