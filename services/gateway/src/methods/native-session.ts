import {
  Methods,
  type NativeSessionCreateParams,
  type NativeSessionResponse,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import { currentSessionOriginator } from '../security/work-originator.js';

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
function string(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim())
    throw new GatewayMethodError('INVALID_PARAMS', `${key} must be a nonempty string`);
  return value;
}

export async function nativeSessionRoute(method: string, value: unknown): Promise<unknown> {
  const principal = owner();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected native session parameters');
  const p = value as Record<string, unknown>;
  try {
    switch (method) {
      case Methods.NATIVE_SESSION_CREATE: {
        const params: NativeSessionCreateParams = {
          runner: string(p, 'runner'),
          cwd: string(p, 'cwd'),
        };
        if (p.model !== undefined) params.model = string(p, 'model');
        if (p.mode !== undefined) {
          if (p.mode !== 'default' && p.mode !== 'plan')
            throw new GatewayMethodError('INVALID_PARAMS', 'Unknown native interaction mode');
          params.mode = p.mode;
        }
        if (p.resumeSessionId !== undefined) params.resumeSessionId = string(p, 'resumeSessionId');
        return { session: await nativeSessionManager.create(principal, params) };
      }
      case Methods.NATIVE_SESSION_LIST:
        return { sessions: await nativeSessionManager.list(principal) };
      case Methods.NATIVE_SESSION_READ:
        if (p.limit !== undefined && typeof p.limit !== 'number')
          throw new GatewayMethodError('INVALID_PARAMS', 'limit must be an integer');
        if (p.after !== undefined && typeof p.after !== 'number')
          throw new GatewayMethodError('INVALID_PARAMS', 'after must be an integer');
        return await nativeSessionManager.read(
          principal,
          string(p, 'sessionId'),
          p.after as number | undefined,
          p.limit as number | undefined,
        );
      case Methods.NATIVE_SESSION_SEND: {
        const commandId = string(p, 'commandId');
        return await nativeSessionManager.send(
          principal,
          string(p, 'sessionId'),
          commandId,
          string(p, 'text'),
        );
      }
      case Methods.NATIVE_SESSION_RESPOND: {
        const response: NativeSessionResponse = {};
        if (p.decision !== undefined) {
          if (p.decision !== 'approve' && p.decision !== 'deny')
            throw new GatewayMethodError('INVALID_PARAMS', 'Unknown approval decision');
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
            throw new GatewayMethodError(
              'INVALID_PARAMS',
              'answers must map question IDs to string arrays',
            );
          response.answers = p.answers as Record<string, string[]>;
        }
        if (Boolean(response.decision) === Boolean(response.answers))
          throw new GatewayMethodError('INVALID_PARAMS', 'Supply either a decision or answers');
        await nativeSessionManager.respond(
          principal,
          string(p, 'sessionId'),
          string(p, 'requestId'),
          response,
        );
        return { responded: true };
      }
      case Methods.NATIVE_SESSION_INTERRUPT:
        await nativeSessionManager.interrupt(principal, string(p, 'sessionId'));
        return { interrupted: true };
      case Methods.NATIVE_SESSION_CLOSE:
        await nativeSessionManager.close(principal, string(p, 'sessionId'));
        return {
          closed: true,
          session: (await nativeSessionManager.read(principal, string(p, 'sessionId'))).session,
        };
      default:
        throw new Error('Unknown native session method');
    }
  } catch (error) {
    if (error instanceof GatewayMethodError) throw error;
    throw new GatewayMethodError('NATIVE_SESSION_ERROR', (error as Error).message);
  }
}
