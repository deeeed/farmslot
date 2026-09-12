import {
  Methods,
  type NativeSessionCreateParams,
  type NativeSessionResponse,
} from '@farmslot/protocol';

import type { NativeSessionClient } from './client.js';
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
  if (p.executionNodeId !== undefined && p.executionNodeId !== client.executionNodeId)
    throw new NativeSessionMethodError(
      'INVALID_PARAMS',
      'Native session targets another execution node',
    );
  try {
    switch (method) {
      case Methods.NATIVE_SESSION_WORKSPACE_LIST:
      case Methods.NATIVE_SESSION_WORKSPACE_READ:
      case Methods.NATIVE_SESSION_WORKSPACE_CHANGES:
      case Methods.NATIVE_SESSION_WORKSPACE_DIFF: {
        const { session } = await client.read(principal, string(p, 'sessionId'), undefined, 1);
        if (method === Methods.NATIVE_SESSION_WORKSPACE_CHANGES)
          return await nativeWorkspaceChanges(session.cwd);
        const path = string(p, 'path');
        if (method === Methods.NATIVE_SESSION_WORKSPACE_LIST)
          return await nativeWorkspaceList(session.cwd, path);
        if (method === Methods.NATIVE_SESSION_WORKSPACE_DIFF)
          return { path, diff: await nativeWorkspaceDiff(session.cwd, path) };
        return { path, content: await readWorkspaceText(session.cwd, path) };
      }
      case Methods.NATIVE_SESSION_CREATE: {
        const params: NativeSessionCreateParams = {
          runner: string(p, 'runner'),
          cwd: string(p, 'cwd'),
        };
        if (p.model !== undefined) params.model = string(p, 'model');
        if (p.mode !== undefined) {
          if (p.mode !== 'default' && p.mode !== 'plan')
            throw new NativeSessionMethodError('INVALID_PARAMS', 'Unknown native interaction mode');
          params.mode = p.mode;
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
