import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { NativeConversationUpdate } from '@farmslot/protocol';

import { subscribeHost } from './conversation-ipc.js';

test('passive IPC keeps initial-before-live order and closes observation on unsubscribe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-ipc-'));
  const socket = join(root, 's');
  let peerClosed = false;
  const server = createServer({ allowHalfOpen: true }, (peer) => {
    let input = '';
    peer.on('data', (chunk) => {
      input += String(chunk);
    });
    peer.on('close', () => {
      peerClosed = true;
    });
    peer.on('end', () => {
      assert.equal(JSON.parse(input).request.method, 'subscribe');
      peer.write(JSON.stringify({ value: { kind: 'terminal', reason: 'resync-required' } }) + '\n');
      peer.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const seen: NativeConversationUpdate[] = [];
  const subscription = await subscribeHost(
    { pid: process.pid, token: 'fixture', socket },
    { method: 'subscribe', owner: 'owner', id: 'session' },
    (update) => seen.push(update),
  );
  assert.equal(subscription.initial.kind, 'terminal');
  subscription.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [], 'normal terminal close must not manufacture a second source failure');
  subscription.stop();
  await new Promise<void>((resolve) => {
    if (peerClosed) resolve();
    else setImmediate(resolve);
  });
});
