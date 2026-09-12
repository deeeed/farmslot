import { createHash, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';

import type {
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionResponse,
} from '@farmslot/protocol';

export interface HostIdentity {
  executionNodeId?: string;
  supportsEnsure?: boolean;
  pid: number;
  token: string;
  socket: string;
}
export type HostRequest =
  | { method: 'create'; owner: string; params: NativeSessionCreateParams }
  | { method: 'ensure'; owner: string; params: NativeSessionEnsureParams }
  | { method: 'list'; owner: string }
  | { method: 'read'; owner: string; id: string; after?: number; limit?: number }
  | { method: 'send'; owner: string; id: string; commandId: string; text: string }
  | {
      method: 'respond';
      owner: string;
      id: string;
      requestId: string;
      response: NativeSessionResponse;
    }
  | { method: 'interrupt' | 'close'; owner: string; id: string };
export function socketDirectory(root: string): string {
  return join(
    '/tmp',
    `fsn-${process.getuid?.()}-${createHash('sha256').update(root).digest('hex').slice(0, 20)}`,
  );
}
export function authenticated(actual: unknown, expected: string): boolean {
  return (
    typeof actual === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected IPC object');
  return value as Record<string, unknown>;
}
function string(p: Record<string, unknown>, key: string): string {
  if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`Invalid IPC ${key}`);
  return p[key];
}
export function decodeRequest(value: unknown): HostRequest {
  const p = object(value);
  const owner = string(p, 'owner');
  const method = p.method;
  if (method === 'list') return { method, owner };
  if (method === 'create' || method === 'ensure') {
    const v = object(p.params);
    const params: NativeSessionCreateParams = {
      runner: string(v, 'runner'),
      cwd: string(v, 'cwd'),
    };
    if (v.model !== undefined) params.model = string(v, 'model');
    if (v.resumeSessionId !== undefined) params.resumeSessionId = string(v, 'resumeSessionId');
    if (v.mode !== undefined) {
      if (v.mode !== 'default' && v.mode !== 'plan') throw new Error('Invalid native mode');
      params.mode = v.mode;
    }
    if (method === 'ensure') {
      if (v.resumeSessionId !== undefined) throw new Error('Reserved sessionId is not for resume');
      return { method, owner, params: { ...params, sessionId: string(v, 'sessionId') } };
    }
    return { method, owner, params };
  }
  const id = string(p, 'id');
  if (method === 'read') {
    if (
      (p.after !== undefined && typeof p.after !== 'number') ||
      (p.limit !== undefined && typeof p.limit !== 'number')
    )
      throw new Error('Invalid cursor/limit');
    return { method, owner, id, after: p.after, limit: p.limit };
  }
  if (method === 'send')
    return { method, owner, id, commandId: string(p, 'commandId'), text: string(p, 'text') };
  if (method === 'close' || method === 'interrupt') return { method, owner, id };
  if (method === 'respond') {
    const v = object(p.response);
    const response: NativeSessionResponse = {};
    if (v.decision === 'approve' || v.decision === 'deny') response.decision = v.decision;
    if (v.answers !== undefined) {
      const answers = object(v.answers);
      response.answers = {};
      for (const [id, values] of Object.entries(answers)) {
        if (
          !Array.isArray(values) ||
          !values.every((value): value is string => typeof value === 'string')
        )
          throw new Error('Invalid native answers');
        response.answers[id] = values;
      }
    }
    if (Boolean(response.decision) === Boolean(response.answers))
      throw new Error('Supply a decision or answers');
    return { method, owner, id, requestId: string(p, 'requestId'), response };
  }
  throw new Error('Unknown native host method');
}
/** One attempt only. A lost reply never causes an implicit mutation retry. */
export function requestHost<T>(host: HostIdentity, request: HostRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(host.socket);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(45_000, () =>
      socket.destroy(new Error('Native host reply timed out; mutation outcome is unknown')),
    );
    socket.on('error', reject);
    socket.on('connect', () => socket.end(`${JSON.stringify({ token: host.token, request })}\n`));
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received) > 8 * 1024 * 1024)
        socket.destroy(new Error('Native host reply exceeds limit'));
    });
    socket.on('end', () => {
      try {
        const result = object(JSON.parse(received));
        if (typeof result.error === 'string') throw new Error(result.error);
        resolve(result.value as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}
