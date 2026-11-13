// Loopback-only proof node using the production exec and filesystem handlers.
import { WebSocket } from 'ws';

import type { NodeExecParams } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import { exec } from '../../../node/src/commands/exec.js';
import { fsExists, fsRead, fsStat } from '../../../node/src/commands/fs.js';

const [endpoint, machine] = process.argv.slice(2);
const url = new URL(endpoint);
if (url.hostname !== '127.0.0.1') throw new Error('Proof node requires loopback');
const socket = new WebSocket(url);
const controllers = new Map<string, AbortController>();
let executions = 0;
let denied = 0;
function execParams(params: Record<string, unknown>): NodeExecParams {
  if (typeof params.cwd !== 'string') throw new Error('Missing fixture cwd');
  const options = {
    cwd: params.cwd,
    ...(typeof params.timeout === 'number' ? { timeout: params.timeout } : {}),
    ...(typeof params.maxBuffer === 'number' ? { maxBuffer: params.maxBuffer } : {}),
    ...(typeof params.closeoutTimeoutMs === 'number'
      ? { closeoutTimeoutMs: params.closeoutTimeoutMs }
      : {}),
    ...(params.requestScoped === true ? { requestScoped: true } : {}),
  };
  if (Array.isArray(params.argv) && params.argv.every((arg) => typeof arg === 'string'))
    return { ...options, argv: params.argv };
  if (typeof params.cmd === 'string') return { ...options, cmd: params.cmd };
  throw new Error('Missing fixture command');
}
async function answer(raw: unknown): Promise<void> {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.method !== 'string' ||
    !isRecord(raw.params)
  )
    throw new Error('Invalid fixture frame');
  const { id, method, params } = raw;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    let result: unknown;
    if (method === 'exec') {
      executions++;
      result = await exec(execParams(params), undefined, controller.signal);
    } else if (method === 'exec.cancel') {
      if (typeof params.requestId === 'string') controllers.get(params.requestId)?.abort();
      result = { cancelled: true };
    } else {
      if (typeof params.root !== 'string' || typeof params.relPath !== 'string')
        throw new Error('Invalid fixture path');
      const target = { root: params.root, relPath: params.relPath };
      if (method === 'fs.exists') result = await fsExists(target);
      else if (method === 'fs.stat') result = await fsStat(target);
      else if (method === 'fs.read') result = await fsRead(target);
      else throw new Error('Unsupported fixture request');
    }
    socket.send(JSON.stringify({ id, ok: true, result }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === 'Access to .git is not allowed') denied++;
    socket.send(JSON.stringify({ id, ok: false, error: error.message }));
  } finally {
    controllers.delete(id);
  }
}
socket.once('open', () => socket.send(JSON.stringify({ machine, pid: process.pid })));
socket.on('message', (raw) => {
  void answer(JSON.parse(String(raw)));
});
socket.on('close', () => {
  for (const controller of controllers.values()) controller.abort();
  process.disconnect?.();
});
process.on('message', (message) => {
  if (isRecord(message) && message.type === 'stats') process.send?.({ executions, denied });
  if (isRecord(message) && message.type === 'shutdown') socket.close();
});
