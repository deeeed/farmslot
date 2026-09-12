import { routeNativeSession } from '@farmslot/agent-runtime/native/service';
import { Methods, type NativeSessionInfo, type NativeSessionListResult } from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { getAllNodes, getNode } from '../../fleet/machine-registry.js';
import { sendNodeRequest } from '../../fleet/node-rpc.js';

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
  if (method === Methods.NATIVE_SESSION_CREATE || method === Methods.NATIVE_SESSION_ENSURE) {
    if (
      typeof params.runner !== 'string' ||
      (params.model !== undefined && typeof params.model !== 'string')
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Expected native runner and model strings');
    validateNativeRunner(params.runner, params.model);
  }
  if (executionNodeId === 'local')
    return routeNativeSession(nativeSessionManager, owner, method, params);
  const node = getNode(executionNodeId);
  if (!node || node.nativeSessions?.ownerPrincipalId !== owner)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  const result = await sendNodeRequest(
    node,
    'native.session',
    { owner, method, params },
    { timeout: 60_000, requireSameConnection: true },
  );
  const hasSession = [
    Methods.NATIVE_SESSION_CREATE,
    Methods.NATIVE_SESSION_ENSURE,
    Methods.NATIVE_SESSION_READ,
    Methods.NATIVE_SESSION_CLOSE,
  ].some((candidate) => candidate === method);
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
  const nodes = [
    ...new Set([
      'local',
      ...knownNativeExecutionNodes(owner),
      ...getAllNodes()
        .filter((node) => getNode(node.machine)?.nativeSessions?.ownerPrincipalId === owner)
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
