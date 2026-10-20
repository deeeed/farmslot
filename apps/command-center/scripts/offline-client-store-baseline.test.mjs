import assert from 'node:assert/strict';
import { test } from 'node:test';

import { measureOfflineClientStore } from './offline-client-store-baseline.mjs';

function fixture(frames, { closeCount = 1 } = {}) {
  let receive;
  let closed = false;
  const socket = {
    async call(method, params) {
      if (method === 'Performance.getMetrics')
        return {
          metrics: [
            { name: 'Timestamp', value: 10 },
            { name: 'NavigationStart', value: 10 },
          ],
        };
      if (method === 'Runtime.evaluate')
        return {
          result: {
            objectId: 'prototype',
            value: params.expression.includes('paintedAt') ? { paintedAt: 900 } : '#gate',
          },
        };
      if (method === 'Runtime.queryObjects') return { objects: { objectId: 'sockets' } };
      if (['Page.reload', 'Page.navigate', 'Runtime.callFunctionOn'].includes(method)) {
        queueMicrotask(() => {
          for (const [direction, frame, timestamp] of frames)
            receive({
              method: `Network.webSocketFrame${direction}`,
              params: {
                requestId: 'socket',
                timestamp,
                response: { opcode: 1, payloadData: JSON.stringify(frame) },
              },
            });
        });
        if (method === 'Runtime.callFunctionOn')
          return { result: { value: { count: closeCount, closedAt: 50 } } };
      }
      return {};
    },
    close() {
      closed = true;
    },
  };
  return {
    connect: async (_url, listener) => {
      receive = listener;
      return socket;
    },
    tab: { url: 'http://localhost/#runs', webSocketDebuggerUrl: 'ws://localhost/cdp' },
    isClosed: () => closed,
  };
}

test('bulk and first-list timings remain distinct and Vite bytes are excluded', async () => {
  const active = { type: 'res', id: 'active', ok: true, payload: { runs: [] } };
  const inventory = { type: 'res', id: 'inventory', ok: true, payload: { runs: ['é'] } };
  const f = fixture([
    ['Sent', { type: 'req', id: 'active', method: 'run.list', params: { active: true } }, 10.1],
    ['Sent', { type: 'req', id: 'inventory', method: 'run.list', params: { limit: 1000 } }, 10.1],
    ['Received', { type: 'update', data: 'Vite update' }, 10.2],
    ['Received', active, 10.2],
    ['Received', inventory, 10.4],
  ]);
  const result = await measureOfflineClientStore({ ...f, phase: 'cold' });
  assert.equal(result.elapsedMs, 400);
  assert.equal(result.firstRunListMs, 200);
  assert.equal(
    result.receivedBytes,
    Buffer.byteLength(JSON.stringify(active) + JSON.stringify(inventory)),
  );
  assert.equal(result.runCount, 1);
  assert(f.isClosed());
});

test('an unrelated diff cannot satisfy the named gate measurement', async () => {
  const f = fixture([
    ['Sent', { type: 'req', id: 'wrong', method: 'git.diff', params: { slotId: 'other' } }, 10.1],
    ['Received', { type: 'res', id: 'wrong', ok: true }, 10.2],
    [
      'Sent',
      { type: 'req', id: 'right', method: 'git.diff', params: { slotId: 'expected' } },
      10.3,
    ],
    ['Received', { type: 'res', id: 'right', ok: true }, 10.8],
  ]);
  const result = await measureOfflineClientStore({
    ...f,
    phase: 'diff',
    route: 'gate',
    match: { slotId: 'expected' },
  });
  assert.equal(result.elapsedMs, 800);
  assert.equal(result.requestMs, 500);
  assert.equal(result.renderedMs, 900);
});

test('reconnect excludes native-object discovery and refuses a missing socket', async () => {
  const frames = [
    ['Sent', { type: 'req', id: 'list', method: 'run.list', params: {} }, 10.1],
    ['Received', { type: 'res', id: 'list', ok: true, payload: { runs: [] } }, 10.4],
  ];
  const result = await measureOfflineClientStore({ ...fixture(frames), phase: 'reconnect' });
  assert.equal(result.elapsedMs, 350);
  const missing = fixture([], { closeCount: 0 });
  await assert.rejects(
    measureOfflineClientStore({ ...missing, phase: 'reconnect' }),
    /No live gateway socket/,
  );
  assert(missing.isClosed());
});
