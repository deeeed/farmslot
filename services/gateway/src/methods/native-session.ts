import { NativeSessionMethodError } from '@farmslot/agent-runtime/native/service';
import { Methods, type Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import {
  listNativeExecutions,
  resolveNativeExecutionNode,
  routeNativeExecution,
} from '../runners/native/node.js';
import {
  NATIVE_WORKER_READ_METHODS,
  routeNativeWorkerRead,
} from '../runners/native/worker-history.js';
import {
  NATIVE_WORKER_INPUT_METHODS,
  routeNativeWorkerInput,
} from '../runners/native/worker-input.js';
import { nativeOwnerCanUseWorkers, requireNativeSessionOwner } from '../security/native-owner.js';
import {
  isStandaloneAdmin,
  standaloneOwner,
  standaloneOwners,
} from '../security/native-standalone.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import { nativeCatalog } from './native-workspace.js';

export async function nativeSessionRoute(
  method: string,
  value: unknown,
  actingPrincipal: Principal,
  emit: (event: string, payload: unknown) => void = () => {},
): Promise<unknown> {
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal')
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native workspace requires an authenticated owner',
    );
  if (actingPrincipal.id !== originator.principalId)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native caller authority does not match its owner',
    );
  const allowWorkers = nativeOwnerCanUseWorkers(actingPrincipal);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected native session parameters');
  const params = value as Record<string, unknown>;
  for (const key of [
    'owner',
    'ownerId',
    'ownerPrincipalId',
    'ownerGeneration',
    'requester',
    'requestedByPrincipalId',
    'requestedByPrincipalGeneration',
  ])
    if (key in params)
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        'Native owner and requester attribution are server-derived',
      );
  try {
    if (!allowWorkers && params.worker !== undefined)
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native workspace enrollment does not grant worker controls',
      );
    if ('launch' in params)
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        'Worker launch settings are supplied by run dispatch',
      );
    // Pinned worker routes validate the stored owner and the caller's supervision authority.
    if (params.worker !== undefined && NATIVE_WORKER_INPUT_METHODS.includes(method))
      return await routeNativeWorkerInput(method, params, emit);
    if (params.worker !== undefined && NATIVE_WORKER_READ_METHODS.includes(method))
      return await routeNativeWorkerRead(method, params);
    if (params.worker !== undefined)
      throw new GatewayMethodError('INVALID_PARAMS', 'Worker control requires its pinned route');
    const delegated = isStandaloneAdmin(actingPrincipal);
    const principal = delegated ? actingPrincipal.id : requireNativeSessionOwner();
    if (method === Methods.NATIVE_SESSION_CATALOG)
      return await nativeCatalog(principal, allowWorkers, delegated ? actingPrincipal : undefined);
    if (method === Methods.NATIVE_SESSION_LIST && params.executionNodeId === undefined) {
      if (delegated) {
        const targets = [...standaloneOwners(actingPrincipal).keys()];
        const pages = await Promise.allSettled(
          targets.map(async (executionNodeId) => {
            const owner = standaloneOwner(actingPrincipal, executionNodeId);
            const node =
              executionNodeId === 'local'
                ? undefined
                : resolveNativeExecutionNode(owner, executionNodeId);
            const result = await routeNativeExecution(owner, method, { executionNodeId });
            return { owner, node, result };
          }),
        );
        const sessions: import('@farmslot/protocol').NativeSessionInfo[] = [];
        const unavailableExecutionNodes: Array<{ executionNodeId: string; message: string }> = [];
        for (const [index, page] of pages.entries()) {
          try {
            if (page.status === 'rejected') throw page.reason;
            const executionNodeId = targets[index];
            const { owner, node, result } = page.value;
            // A fast response is not authority while another target is still pending.
            if (
              standaloneOwner(actingPrincipal, executionNodeId) !== owner ||
              (node && resolveNativeExecutionNode(owner, executionNodeId) !== node)
            )
              throw new GatewayMethodError(
                'NATIVE_SOURCE_UNAVAILABLE',
                'Native target authority changed while listing sessions',
              );
            const inventory = result as import('@farmslot/protocol').NativeSessionListResult;
            sessions.push(...inventory.sessions.filter((session) => !session.workerManaged));
          } catch (error) {
            unavailableExecutionNodes.push({
              executionNodeId: targets[index],
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        standaloneOwners(actingPrincipal);
        return { sessions, unavailableExecutionNodes };
      }
      const result = await listNativeExecutions(principal);
      return { ...result, sessions: result.sessions.filter((session) => !session.workerManaged) };
    }
    const executionNodeId =
      typeof params.executionNodeId === 'string' ? params.executionNodeId : 'local';
    const owner = delegated ? standaloneOwner(actingPrincipal, executionNodeId) : principal;
    if (
      typeof params.sessionId === 'string' &&
      method !== Methods.NATIVE_SESSION_ENSURE &&
      !method.startsWith('native.profile.')
    ) {
      const inspected = (await routeNativeExecution(owner, Methods.NATIVE_SESSION_READ, {
        executionNodeId,
        sessionId: params.sessionId,
        limit: 1,
      })) as import('@farmslot/protocol').NativeSessionReadResult;
      if (inspected.session.workerManaged)
        throw new GatewayMethodError(
          'AUTH_FORBIDDEN',
          allowWorkers
            ? 'Worker-managed sessions require pinned worker controls'
            : 'Native workspace enrollment does not grant worker access',
        );
      if (method === Methods.NATIVE_SESSION_SET_APPROVAL_MODE && params.approvalMode === 'bypass') {
        const { getCopilotRuntime } = await import('../copilot-runtime/controller.js');
        const runtime = getCopilotRuntime();
        await runtime.initialize();
        const copilot = runtime.currentSession();
        if (
          copilot?.nativeSession?.sessionId === inspected.session.id &&
          (copilot.nativeSession.executionNodeId ?? 'local') === executionNodeId &&
          copilot.safetyTier !== 'dangerous'
        )
          throw new GatewayMethodError(
            'INVALID_PARAMS',
            'Use the Co-Pilot dangerous-start confirmation to change its tool policy',
          );
      }
      if (delegated && standaloneOwner(actingPrincipal, executionNodeId) !== owner)
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native target owner changed');
    }
    const requester =
      delegated &&
      [Methods.NATIVE_SESSION_CREATE, Methods.NATIVE_SESSION_ENSURE].some(
        (candidate) => candidate === method,
      )
        ? { principalId: actingPrincipal.id, principalGeneration: actingPrincipal.generation ?? 0 }
        : undefined;
    const result = await routeNativeExecution(owner, method, params, requester);
    if (delegated && standaloneOwner(actingPrincipal, executionNodeId) !== owner)
      throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native target owner changed');
    if (
      result &&
      typeof result === 'object' &&
      'session' in result &&
      (result.session as { workerManaged?: boolean })?.workerManaged
    )
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native workspace enrollment does not grant worker access',
      );
    if (method === Methods.NATIVE_SESSION_LIST) {
      const inventory = result as { sessions: Array<{ workerManaged?: boolean }> };
      return {
        ...inventory,
        sessions: inventory.sessions.filter((session) => !session.workerManaged),
      };
    }
    return result;
  } catch (error) {
    throw nativeRouteError(error);
  }
}

const NATIVE_ROUTE_ERROR_CODES = [
  'INVALID_PARAMS',
  'AUTH_FORBIDDEN',
  'NATIVE_SESSION_ERROR',
  'NOT_FOUND',
  'NATIVE_SOURCE_UNAVAILABLE',
  'NATIVE_PROFILES_UNAVAILABLE',
  'RESOURCE_OBSERVATION_CHANGED',
];

/** Keeps a native host or node error code clients act on; anything else is a session error. */
export function nativeRouteError(error: unknown): GatewayMethodError {
  if (error instanceof NativeSessionMethodError)
    return new GatewayMethodError(error.code, error.message);
  if (error instanceof GatewayMethodError) return error;
  const nodeCode = (error as NodeJS.ErrnoException).code;
  if (nodeCode && NATIVE_ROUTE_ERROR_CODES.includes(nodeCode))
    return new GatewayMethodError(nodeCode, (error as Error).message);
  return new GatewayMethodError('NATIVE_SESSION_ERROR', (error as Error).message);
}
