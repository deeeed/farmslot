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

function fixture(frames, { closeCount = 1, merged } = {}) {
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
      if (method === 'Runtime.evaluate' && params.expression === 'Date.now()')
        return { result: { value: 999_000 } };
      if (method === 'Runtime.evaluate' && params.expression.includes('data-runs-observed-at'))
        return merged
          ? { result: { value: merged } }
          : {
              exceptionDetails: { exception: { description: 'Error: Open the run list (#runs)' } },
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
          return { result: { value: { count: closeCount, closedAt: 50, closedWall: 999_000 } } };
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
  assert.equal(result.catchUpPages, undefined, "an older gateway's cold start ends at its reply");
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
  assert.equal(result.catchUpPages, undefined, "an older gateway's reconnect ends at its reply");
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

test('a version-list reconnect ends at the merged ready state, not at the version reply', async () => {
  const versions = {
    type: 'res',
    id: 'versions',
    ok: true,
    payload: { runs: [], totalCount: 2, versions: [{ id: 'a' }, { id: 'b' }] },
  };
  const first = { type: 'res', id: 'page-1', ok: true, payload: { runs: ['a'] } };
  const second = { type: 'res', id: 'page-2', ok: true, payload: { runs: ['b'] } };
  const later = { type: 'event', event: 'resource.changed' };
  const f = fixture(
    [
      [
        'Sent',
        { type: 'req', id: 'versions', method: 'run.list', params: { versions: true } },
        10.1,
      ],
      ['Received', versions, 10.15],
      ['Sent', { type: 'req', id: 'page-1', method: 'run.list', params: { ids: ['a'] } }, 10.16],
      ['Received', first, 10.3],
      ['Sent', { type: 'req', id: 'page-2', method: 'run.list', params: { ids: ['b'] } }, 10.31],
      ['Received', second, 10.45],
      ['Received', later, 10.6],
    ],
    // The cache stamped the merge 460 ms after the page's time origin.
    { merged: { observedAt: 1_000_460, timeOrigin: 1_000_000 } },
  );
  const result = await measureOfflineClientStore({ ...f, phase: 'reconnect' });
  assert.equal(result.elapsedMs, 410, 'socket close to merged ready');
  assert.equal(result.firstRunListMs, 100, 'the version reply comes first');
  assert.equal(result.runCount, 2);
  assert.equal(result.catchUpPages, 2);
  const size = (frame) => Buffer.byteLength(JSON.stringify(frame));
  assert.equal(result.catchUpBytes, size(first) + size(second));
  assert.equal(result.receivedBytes, size(versions) + size(first) + size(second));
});

test('a reconnect with nothing changed ends when the run list is ready after the version reply', async () => {
  const f = fixture(
    [
      [
        'Sent',
        { type: 'req', id: 'versions', method: 'run.list', params: { versions: true } },
        10.1,
      ],
      ['Received', { type: 'res', id: 'versions', ok: true, payload: { runs: [] } }, 10.15],
    ],
    { merged: { observedAt: 1_000_200, timeOrigin: 1_000_000 } },
  );
  const result = await measureOfflineClientStore({ ...f, phase: 'reconnect' });
  assert.equal(result.elapsedMs, 150);
  assert.equal(result.catchUpPages, 0);
});

test('a version-list reconnect is refused without the run list open to report its ready state', async () => {
  const f = fixture([
    ['Sent', { type: 'req', id: 'versions', method: 'run.list', params: { versions: true } }, 10.1],
    ['Received', { type: 'res', id: 'versions', ok: true, payload: { runs: [] } }, 10.15],
  ]);
  await assert.rejects(
    measureOfflineClientStore({ ...f, phase: 'reconnect' }),
    /Open the run list/,
  );
  assert(f.isClosed());
});

test('a version-list cold start ends at the merged ready state, not at the version reply', async () => {
  const versions = {
    type: 'res',
    id: 'versions',
    ok: true,
    payload: { runs: [], totalCount: 1, versions: [{ id: 'a' }] },
  };
  const page = { type: 'res', id: 'page', ok: true, payload: { runs: ['a'] } };
  const later = { type: 'event', event: 'resource.changed' };
  const f = fixture(
    [
      [
        'Sent',
        { type: 'req', id: 'versions', method: 'run.list', params: { versions: true } },
        10.1,
      ],
      ['Received', versions, 10.15],
      ['Sent', { type: 'req', id: 'page', method: 'run.list', params: { ids: ['a'] } }, 10.16],
      ['Received', page, 10.3],
      ['Received', later, 10.6],
    ],
    // The cache stamped the merge 350 ms after the page's time origin.
    { merged: { observedAt: 1_000_350, timeOrigin: 1_000_000 } },
  );
  const result = await measureOfflineClientStore({ ...f, phase: 'cold' });
  assert.equal(result.elapsedMs, 350, 'navigation to merged ready');
  assert.equal(result.firstRunListMs, 150, 'the version reply comes first');
  assert.equal(result.catchUpPages, 1);
  const size = (frame) => Buffer.byteLength(JSON.stringify(frame));
  assert.equal(result.receivedBytes, size(versions) + size(page));
  assert.match(result.timing, /merged ready/);
});

test("an older gateway's reconnect ends at its single full reply, as the D07 baseline measured", async () => {
  const reply = { type: 'res', id: 'list', ok: true, payload: { runs: ['a'] } };
  const f = fixture(
    [
      ['Sent', { type: 'req', id: 'list', method: 'run.list', params: { limit: 1000 } }, 10.1],
      ['Received', reply, 10.4],
      ['Received', { type: 'event', event: 'resource.changed' }, 10.6],
    ],
    // A later ready stamp must not move the end of a reconnect without version lists.
    { merged: { observedAt: 1_000_900, timeOrigin: 1_000_000 } },
  );
  const result = await measureOfflineClientStore({ ...f, phase: 'reconnect' });
  assert.equal(result.elapsedMs, 350);
  assert.equal(result.receivedBytes, Buffer.byteLength(JSON.stringify(reply)));
  assert.match(result.timing, /inventory run\.list reply/);
  assert.equal(result.catchUpPages, undefined);
});
