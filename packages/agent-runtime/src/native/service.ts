import {
  Methods,
  type NativeSessionCreateParams,
  type NativeSessionResponse,
} from '@farmslot/protocol';

import type { NativeSessionClient } from './client.js';
import { NATIVE_PROFILE_METHODS, routeNativeProfile } from './profile-service.js';
import { nativeWorkspaceChanges, nativeWorkspaceDiff, nativeWorkspaceList } from './workspace.js';
import { readWorkspaceText } from './workspace-files.js';

export class NativeSessionMethodError extends Error {
  constructor(
    readonly code: 'INVALID_PARAMS' | 'NATIVE_SESSION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'NativeSessionMethodError';
  }
}

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim())
    throw new NativeSessionMethodError('INVALID_PARAMS', `${key} must be a nonempty string`);
  return value;
}

export async function routeNativeSession(
  client: NativeSessionClient,
  principal: string,
  method: string,
  value: unknown,
): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NativeSessionMethodError('INVALID_PARAMS', 'Expected native session parameters');
  const p = value as Record<string, unknown>;
  if ('launch' in p)
    throw new NativeSessionMethodError(
      'INVALID_PARAMS',
      'Worker launch settings are supplied by run dispatch',
    );
  if (p.executionNodeId !== undefined && p.executionNodeId !== client.executionNodeId)
    throw new NativeSessionMethodError(
      'INVALID_PARAMS',
      'Native session targets another execution node',
    );
  try {
    if (NATIVE_PROFILE_METHODS.includes(method))
      return await routeNativeProfile(client, principal, method, p);
    switch (method) {
      case Methods.NATIVE_SESSION_WORKSPACE_LIST:
      case Methods.NATIVE_SESSION_WORKSPACE_READ:
      case Methods.NATIVE_SESSION_WORKSPACE_CHANGES:
      case Methods.NATIVE_SESSION_WORKSPACE_DIFF: {
        const sessionId = string(p, 'sessionId');
        const inspect = async () => {
          const { session } = await client.read(principal, sessionId, undefined, 1);
          if (session.workerManaged) {
            const worker = p.worker;
            if (!worker || typeof worker !== 'object' || Array.isArray(worker))
              throw new Error('Worker workspace requires its pinned run context');
            const target = worker as Record<string, unknown>;
            if (
              session.workerLeaseId !== target.leaseId ||
              session.generation !== target.generation ||
              ['closed', 'failed', 'closing'].includes(session.state)
            )
              throw new Error(
                'Current workspace is unavailable for a closed or transferred worker',
              );
          } else if (p.worker !== undefined)
            throw new Error('Worker workspace target is not a worker');
          return session;
        };
        const session = await inspect();
        let result: unknown;
        if (method === Methods.NATIVE_SESSION_WORKSPACE_CHANGES)
          result = await nativeWorkspaceChanges(session.cwd);
        else {
          const path = string(p, 'path');
          if (method === Methods.NATIVE_SESSION_WORKSPACE_LIST)
            result = await nativeWorkspaceList(session.cwd, path);
          else if (method === Methods.NATIVE_SESSION_WORKSPACE_DIFF)
            result = { path, diff: await nativeWorkspaceDiff(session.cwd, path) };
          else result = { path, content: await readWorkspaceText(session.cwd, path) };
        }
        // File reads await the OS. Refuse their result if a handoff won during that await.
        if (session.workerManaged) await inspect();
        return result;
      }
      case Methods.NATIVE_SESSION_CREATE:
      case Methods.NATIVE_SESSION_ENSURE: {
        const params: NativeSessionCreateParams = {
          runner: string(p, 'runner'),
          cwd: string(p, 'cwd'),
        };
        if (p.model !== undefined) params.model = string(p, 'model');
        if (p.profileId !== undefined) params.profileId = string(p, 'profileId');
        if (p.accountContextId !== undefined)
          params.accountContextId = string(p, 'accountContextId');
        if (p.mode !== undefined) {
          if (p.mode !== 'default' && p.mode !== 'plan')
            throw new NativeSessionMethodError('INVALID_PARAMS', 'Unknown native interaction mode');
          params.mode = p.mode;
        }
        if (method === Methods.NATIVE_SESSION_ENSURE) {
          if (p.resumeSessionId !== undefined)
            throw new NativeSessionMethodError(
              'INVALID_PARAMS',
              'Reserved sessionId is not for resume',
            );
          return {
            session: await client.ensure(principal, {
              ...params,
              sessionId: string(p, 'sessionId'),
            }),
          };
        }
        if (p.resumeSessionId !== undefined) params.resumeSessionId = string(p, 'resumeSessionId');
        return { session: await client.create(principal, params) };
      }
      case Methods.NATIVE_SESSION_LIST:
        return { sessions: await client.list(principal) };
      case Methods.NATIVE_SESSION_READ:
        if (p.limit !== undefined && typeof p.limit !== 'number')
          throw new NativeSessionMethodError('INVALID_PARAMS', 'limit must be an integer');
        if (p.after !== undefined && typeof p.after !== 'number')
          throw new NativeSessionMethodError('INVALID_PARAMS', 'after must be an integer');
        return await client.read(
          principal,
          string(p, 'sessionId'),
          p.after as number | undefined,
          p.limit as number | undefined,
        );
      case Methods.NATIVE_SESSION_SEND: {
        const commandId = string(p, 'commandId');
        return await client.send(principal, string(p, 'sessionId'), commandId, string(p, 'text'));
      }
      case Methods.NATIVE_SESSION_RESPOND: {
        const response: NativeSessionResponse = {};
        if (p.decision !== undefined) {
          if (p.decision !== 'approve' && p.decision !== 'deny')
            throw new NativeSessionMethodError('INVALID_PARAMS', 'Unknown approval decision');
          response.decision = p.decision;
        }
        if (p.answers !== undefined) {
          if (
            !p.answers ||
            typeof p.answers !== 'object' ||
            Array.isArray(p.answers) ||
            !Object.values(p.answers).every(
              (answers) =>
                Array.isArray(answers) && answers.every((answer) => typeof answer === 'string'),
            )
          )
            throw new NativeSessionMethodError(
              'INVALID_PARAMS',
              'answers must map question IDs to string arrays',
            );
          response.answers = p.answers as Record<string, string[]>;
        }
        if (Boolean(response.decision) === Boolean(response.answers))
          throw new NativeSessionMethodError(
            'INVALID_PARAMS',
            'Supply either a decision or answers',
          );
        await client.respond(principal, string(p, 'sessionId'), string(p, 'requestId'), response);
        return { responded: true };
      }
      case Methods.NATIVE_SESSION_INTERRUPT:
        await client.interrupt(principal, string(p, 'sessionId'));
        return { interrupted: true };
      case Methods.NATIVE_SESSION_CLOSE:
        await client.close(principal, string(p, 'sessionId'));
        return {
          closed: true,
          session: (await client.read(principal, string(p, 'sessionId'))).session,
        };
      default:
        throw new Error('Unknown native session method');
    }
  } catch (error) {
    if (error instanceof NativeSessionMethodError) throw error;
    throw new NativeSessionMethodError('NATIVE_SESSION_ERROR', (error as Error).message);
  }
}
