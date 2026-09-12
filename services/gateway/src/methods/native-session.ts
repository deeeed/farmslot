import { NativeSessionMethodError } from '@farmslot/agent-runtime/native/service';
import { Methods } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { listNativeExecutions, routeNativeExecution } from '../runners/native/node.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import { nativeCatalog } from './native-workspace.js';

function owner(): string {
  const originator = currentSessionOriginator();
  const configured = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  if (!configured || originator.kind !== 'principal' || configured !== originator.principalId) {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native execution requires this principal to own the configured native runner profile',
    );
  }
  return originator.principalId;
}

export async function nativeSessionRoute(method: string, value: unknown): Promise<unknown> {
  const principal = owner();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected native session parameters');
  const params = value as Record<string, unknown>;
  try {
    if (method === Methods.NATIVE_SESSION_CATALOG) return await nativeCatalog(principal);
    if (method === Methods.NATIVE_SESSION_LIST && params.executionNodeId === undefined)
      return await listNativeExecutions(principal);
    return await routeNativeExecution(principal, method, params);
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
