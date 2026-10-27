import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  measureOfflineClientStore,
  observeIdleGatewayReads,
} from './offline-client-store-baseline.mjs';

test('idle measurement counts matching outgoing reads without retaining request payloads', async () => {
  let closed = false;
  const result = await observeIdleGatewayReads({
    methods: ['task.progress'],
    durationMs: 10,
    tab: { webSocketDebuggerUrl: 'ws://fixture/' },
    connect: async (_url, receive) => ({
      async call(method) {
        assert.equal(method, 'Network.enable');
        for (const [direction, frame] of [
          ['Sent', { type: 'req', method: 'task.progress', params: { runId: 'private-run' } }],
          ['Sent', { type: 'req', method: 'gateway.ping' }],
          ['Received', { type: 'res', method: 'task.progress' }],
        ])
          receive({
            method: `Network.webSocketFrame${direction}`,
            params: { response: { opcode: 1, payloadData: JSON.stringify(frame) } },
          });
      },
      close() {
        closed = true;
      },
    }),
  });
  assert.deepEqual(result.counts, { 'task.progress': 1 });
  assert.equal(result.total, 1);
  assert(!JSON.stringify(result).includes('private-run'));
  assert(closed);
});

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

test('a gate open counts artifact bytes beside frames and ends at the rendered diff', async () => {
  const f = fixture([
    ['Sent', { type: 'req', id: 'run', method: 'run.get', params: { runId: 'gate' } }, 10.1],
    ['Received', { type: 'res', id: 'run', ok: true, payload: { run: {} } }, 10.2],
  ]);
  const listener = { current: undefined };
  const connect = async (url, receive) => {
    listener.current = receive;
    const socket = await f.connect(url, receive);
    const call = socket.call.bind(socket);
    socket.call = async (method, params) => {
      const result = await call(method, params);
      if (method === 'Page.navigate')
        queueMicrotask(() => {
          for (const [event, value] of [
            [
              'Network.requestWillBeSent',
              {
                requestId: 'a',
                timestamp: 10.3,
                request: {
                  url: 'http://x/api/run-artifact?runId=gate&path=artifacts%2Fp%2Fdiff-1.diff',
                },
              },
            ],
            ['Network.responseReceived', { requestId: 'a', response: { status: 200 } }],
            [
              'Network.loadingFinished',
              { requestId: 'a', timestamp: 10.5, encodedDataLength: 1234 },
            ],
          ])
            listener.current({ method: event, params: value });
        });
      return result;
    };
    return socket;
  };
  const result = await measureOfflineClientStore({
    ...f,
    connect,
    phase: 'gate',
    route: 'run/gate',
    match: { runId: 'gate' },
  });
  assert.equal(result.method, 'run-artifact');
  assert.equal(result.artifactBytes, 1234);
  assert.equal(result.diffReadMs, 500);
  assert.equal(result.renderedMs, 900);
  assert.equal(result.gatewayRequests['run.get'], 1);
  assert(f.isClosed());
});

test('a connected gate open names the live file diff and its reply time', async () => {
  const f = fixture([
    ['Sent', { type: 'req', id: 'file', method: 'git.diff', params: { slotId: 'gate' } }, 10.1],
    ['Received', { type: 'event', event: 'resource.changed', payload: {} }, 10.2],
    ['Received', { type: 'res', id: 'file', ok: true, payload: { diff: 'x' } }, 10.4],
  ]);
  const result = await measureOfflineClientStore({
    ...f,
    phase: 'gate',
    route: 'run/gate',
    match: { runId: 'gate' },
  });
  assert.equal(result.method, 'git.diff');
  assert.equal(result.diffReplyMs, 400);
  assert.equal(result.artifactBytes, 0);
  assert.equal(result.totalBytes, result.receivedBytes);
  assert(f.isClosed());
});
