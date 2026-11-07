import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  Events,
  Methods,
  type NativeSessionReadResult,
  type NativeSessionSubscribeResult,
} from '@farmslot/protocol';

import { GatewayClient } from '../gateway-client.js';

import { followNativeSession } from './native-session-follow.js';

const page: NativeSessionReadResult = {
  session: {
    id: 'session',
    executionNodeId: 'mini',
    generation: 'process',
    ownerPrincipalId: 'farm',
    hostPid: 1,
    runner: 'sample',
    nativeSessionId: 'conversation',
    accountContextId: 'ambient',
    cwd: '/work',
    executable: '/bin/runner',
    version: '1',
    mode: 'default',
    accountMode: 'native',
    state: 'running',
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      resume: true,
    },
  },
  events: [],
  commands: [],
  pendingRequests: [],
  cursor: 0,
  hasMore: false,
};
const cursor = {
  executionNodeId: 'mini',
  sessionId: 'session',
  hostGeneration: 'host',
  generation: 'process',
  sequence: 0,
};
const initial: NativeSessionSubscribeResult = {
  kind: 'reset',
  subscriptionId: 'subscription',
  cursor,
  snapshot: { ...page, historyBefore: 0, truncated: false },
};

test(
  'follow emits initial before coalesced live frames and acknowledges unsubscribe before Ctrl-C closes',
  { timeout: 10_000 },
  async (t) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seen: string[] = [];
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const frame: unknown = JSON.parse(data.toString());
        assert.ok(
          frame &&
            typeof frame === 'object' &&
            'id' in frame &&
            typeof frame.id === 'string' &&
            'method' in frame &&
            typeof frame.method === 'string',
        );
        seen.push(frame.method);
        if (frame.method === Methods.NATIVE_SESSION_SUBSCRIBE) {
          socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: initial }));
          // ws can parse both messages before the first call's Promise continuation.
          socket.send(
            JSON.stringify({
              type: 'event',
              event: Events.NATIVE_SESSION_DELTA,
              payload: {
                kind: 'delta',
                subscriptionId: 'subscription',
                cursor: { ...cursor, sequence: 1 },
                page: {
                  cursor: 1,
                  events: [
                    {
                      sessionId: 'session',
                      generation: 'process',
                      sequence: 1,
                      at: '2026-11-07T00:00:00Z',
                      type: 'text.delta',
                      text: 'streamed text',
                    },
                  ],
                },
              },
            }),
          );
        } else if (frame.method === Methods.NATIVE_SESSION_UNSUBSCRIBE) {
          socket.send(
            JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }),
          );
        } else assert.fail(`Unexpected command ${frame.method}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      timeout: 2_000,
      credential: null,
    });
    const abort = new AbortController();
    const output: unknown[] = [];
    await followNativeSession(
      client,
      { sessionId: 'session', executionNodeId: 'mini' },
      abort.signal,
      (frame) => {
        output.push(frame);
        if (output.length === 2) abort.abort();
      },
    );
    assert.equal(output.length, 2);
    const first = output[0],
      second = output[1];
    assert.ok(first && typeof first === 'object' && 'kind' in first);
    assert.ok(second && typeof second === 'object' && 'kind' in second);
    assert.equal(first.kind, 'reset');
    assert.equal(second.kind, 'delta');
    assert.deepEqual(seen, [Methods.NATIVE_SESSION_SUBSCRIBE, Methods.NATIVE_SESSION_UNSUBSCRIBE]);
  },
);

test('invalid follow targets never open a connection', async () => {
  let connects = 0;
  const client = {
    connect: async () => {
      connects++;
      throw new Error('Must not connect');
    },
  };
  await assert.rejects(
    followNativeSession(client, { sessionId: 12 }, new AbortController().signal, () => undefined),
    /sessionId/,
  );
  await assert.rejects(
    followNativeSession(
      client,
      { sessionId: 'session', ownerPrincipalId: 'foreign' },
      new AbortController().signal,
      () => undefined,
    ),
    /cannot contain/,
  );
  assert.equal(connects, 0);
});

test(
  'a blocked output sink stays bounded, fails visibly and unsubscribes without replay',
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seen: string[] = [];
    wss.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame: unknown = JSON.parse(raw.toString());
        assert(frame && typeof frame === 'object' && 'id' in frame && 'method' in frame);
        seen.push(String(frame.method));
        if (frame.method === Methods.NATIVE_SESSION_SUBSCRIBE) {
          socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: initial }));
          for (let sequence = 1; sequence <= 24; sequence++)
            socket.send(
              JSON.stringify({
                type: 'event',
                event: Events.NATIVE_SESSION_DELTA,
                payload: {
                  kind: 'delta',
                  subscriptionId: initial.subscriptionId,
                  cursor: { ...cursor, sequence },
                  page: {
                    cursor: sequence,
                    events: [
                      {
                        sessionId: 'session',
                        generation: 'process',
                        sequence,
                        at: '2026-11-07T00:00:00Z',
                        type: 'text.delta',
                        text: 'x'.repeat(60 * 1024),
                      },
                    ],
                  },
                },
              }),
            );
        } else if (frame.method === Methods.NATIVE_SESSION_UNSUBSCRIBE)
          socket.send(
            JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }),
          );
        else assert.fail('Unexpected command ' + String(frame.method));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    let writes = 0;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      timeout: 2000,
      credential: null,
    });
    await assert.rejects(
      followNativeSession(
        client,
        { sessionId: 'session', executionNodeId: 'mini' },
        new AbortController().signal,
        (_frame, signal) => {
          writes++;
          return new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        },
      ),
      /exceeded 1 MiB.*last complete emitted cursor/,
    );
    assert.equal(writes, 1, 'No second write is attempted before stdout drains');
    assert.deepEqual(seen, [Methods.NATIVE_SESSION_SUBSCRIBE, Methods.NATIVE_SESSION_UNSUBSCRIBE]);
  },
);
