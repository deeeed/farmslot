import { NativeSessionMethodError } from '@farmslot/agent-runtime/native/service';
import { Methods, type Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { listNativeExecutions, routeNativeExecution } from '../runners/native/node.js';
import {
  NATIVE_WORKER_READ_METHODS,
  routeNativeWorkerRead,
} from '../runners/native/worker-history.js';
import {
  NATIVE_WORKER_INPUT_METHODS,
  routeNativeWorkerInput,
} from '../runners/native/worker-input.js';
import { nativeOwnerCanUseWorkers, requireNativeSessionOwner } from '../security/native-owner.js';

import { nativeCatalog } from './native-workspace.js';

export async function nativeSessionRoute(
  method: string,
  value: unknown,
  actingPrincipal: Principal,
): Promise<unknown> {
  const principal = requireNativeSessionOwner();
  if (actingPrincipal.id !== principal)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native caller authority does not match its owner',
    );
  const allowWorkers = nativeOwnerCanUseWorkers(actingPrincipal);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected native session parameters');
  const params = value as Record<string, unknown>;
  try {
    if (!allowWorkers && params.worker !== undefined)
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native workspace enrollment does not grant worker controls',
      );
    if (
      !allowWorkers &&
      method !== Methods.NATIVE_SESSION_ENSURE &&
      typeof params.sessionId === 'string'
    ) {
      const inspected = (await routeNativeExecution(principal, Methods.NATIVE_SESSION_READ, {
        sessionId: params.sessionId,
        executionNodeId: params.executionNodeId,
        limit: 1,
      })) as { session: { workerManaged?: boolean } };
      if (inspected.session.workerManaged)
        throw new GatewayMethodError(
          'AUTH_FORBIDDEN',
          'Native workspace enrollment does not grant worker access',
        );
    }
    if ('launch' in params)
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        'Worker launch settings are supplied by run dispatch',
      );
    if (params.worker !== undefined && NATIVE_WORKER_INPUT_METHODS.includes(method))
      return await routeNativeWorkerInput(principal, method, params);
    if (params.worker !== undefined && NATIVE_WORKER_READ_METHODS.includes(method))
      return await routeNativeWorkerRead(principal, method, params);
    if (method === Methods.NATIVE_SESSION_CATALOG)
      return await nativeCatalog(principal, allowWorkers);
    if (method === Methods.NATIVE_SESSION_LIST && params.executionNodeId === undefined) {
      const result = await listNativeExecutions(principal);
      return allowWorkers
        ? result
        : { ...result, sessions: result.sessions.filter((session) => !session.workerManaged) };
    }
    const result = await routeNativeExecution(principal, method, params);
    if (
      !allowWorkers &&
      result &&
      typeof result === 'object' &&
      'session' in result &&
      (result.session as { workerManaged?: boolean })?.workerManaged
    )
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native workspace enrollment does not grant worker access',
      );
    if (!allowWorkers && method === Methods.NATIVE_SESSION_LIST) {
      const inventory = result as { sessions: Array<{ workerManaged?: boolean }> };
      return {
        ...inventory,
        sessions: inventory.sessions.filter((session) => !session.workerManaged),
      };
    }
    if (
      method === Methods.NATIVE_SESSION_READ &&
      result &&
      typeof result === 'object' &&
      'session' in result &&
      (result.session as { workerManaged?: boolean })?.workerManaged
    )
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        'Worker history requires its pinned run context',
      );
    return result;
  } catch (error) {
    if (error instanceof NativeSessionMethodError)
      throw new GatewayMethodError(error.code, error.message);
    if (error instanceof GatewayMethodError) throw error;
    const nodeCode = (error as NodeJS.ErrnoException).code;
    if (nodeCode && ['INVALID_PARAMS', 'AUTH_FORBIDDEN', 'NATIVE_SESSION_ERROR'].includes(nodeCode))
      throw new GatewayMethodError(nodeCode, (error as Error).message);
    throw new GatewayMethodError('NATIVE_SESSION_ERROR', (error as Error).message);
  }
}
