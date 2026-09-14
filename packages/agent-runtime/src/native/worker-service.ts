import type { NativeSessionClient } from './client.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionMethodError } from './service.js';
import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
  NATIVE_WORKER_TRANSFER,
} from './worker-launch.js';

/** Private execution-node operation. The gateway derives launch settings from its run/slot config. */
export async function routeNativeWorkerSession(
  client: NativeSessionClient,
  owner: string,
  method: string,
  value: unknown,
): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NativeSessionMethodError('INVALID_PARAMS', 'Expected native worker parameters');
  const params = value as Record<string, unknown>;
  if (params.executionNodeId !== undefined && params.executionNodeId !== client.executionNodeId)
    throw new NativeSessionMethodError(
      'INVALID_PARAMS',
      'Native worker targets another execution node',
    );
  if (method === NATIVE_WORKER_STATE) {
    if (
      typeof params.sessionId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(params.sessionId)
    )
      throw new NativeSessionMethodError('INVALID_PARAMS', 'Expected a reserved worker session ID');
    return { stateDirectory: client.prepareWorkerState(owner, params.sessionId) };
  }
  let request;
  try {
    request = decodeRequest({
      method,
      owner,
      params,
      launch: params.launch,
      id: params.sessionId,
      generation: params.generation,
      leaseId: params.leaseId,
      sourceLeaseId: params.sourceLeaseId,
      resumeCommandId: params.resumeCommandId,
      commandId: params.commandId,
      text: params.text,
      requestId: params.requestId,
      response: params.response,
      after: params.after,
      limit: params.limit,
    });
  } catch (error) {
    throw new NativeSessionMethodError('INVALID_PARAMS', (error as Error).message);
  }
  try {
    if (request.method === NATIVE_WORKER_READ)
      return await client.readWorker(
        owner,
        request.id,
        request.leaseId,
        request.after,
        request.limit,
      );
    if (request.method === NATIVE_WORKER_RESPOND) {
      await client.respondWorker(
        owner,
        { sessionId: request.id, generation: request.generation, leaseId: request.leaseId },
        request.requestId,
        request.response,
      );
      return { responded: true };
    }
    if (request.method === NATIVE_WORKER_CANCEL)
      return await client.cancelWorker(owner, {
        sessionId: request.id,
        generation: request.generation,
        leaseId: request.leaseId,
        sourceLeaseId: request.sourceLeaseId,
        resumeCommandId: request.resumeCommandId,
      });
    if (request.method === NATIVE_WORKER_ENSURE)
      return { session: await client.ensureWorker(owner, request.params, request.launch) };
    if (request.method === NATIVE_WORKER_RESUME)
      return { session: await client.resumeWorker(owner, request.params, request.launch) };
    if (
      request.method === NATIVE_WORKER_SEND ||
      request.method === NATIVE_WORKER_CLOSE ||
      request.method === NATIVE_WORKER_INTERRUPT ||
      request.method === NATIVE_WORKER_TRANSFER
    ) {
      const target = {
        sessionId: request.id,
        generation: request.generation,
        leaseId: request.leaseId,
      };
      if (request.method === NATIVE_WORKER_SEND)
        return await client.sendWorker(owner, target, request.commandId, request.text);
      if (request.method === NATIVE_WORKER_CLOSE)
        return { closed: true, session: await client.closeWorker(owner, target) };
      if (request.method === NATIVE_WORKER_TRANSFER)
        return { session: await client.transferWorker(owner, target, request.launch) };
      await client.interruptWorker(owner, target);
      return { interrupted: true };
    }
    throw new NativeSessionMethodError('INVALID_PARAMS', 'Unknown native worker operation');
  } catch (error) {
    if (error instanceof NativeSessionMethodError) throw error;
    throw new NativeSessionMethodError('NATIVE_SESSION_ERROR', (error as Error).message);
  }
}
