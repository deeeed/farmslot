import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test, { type TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import { connectionFailed, GatewayClient, GatewayConnectionError } from './gateway-client.js';

type Upgrade = 'answer' | 'refuse-503' | 'drop' | 'hang';

/** A local gateway stand-in that answers each request, or fails the upgrade the way a restarting gateway does. */
async function gateway(t: TestContext, upgrade: Upgrade): Promise<string> {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => sockets.add(socket));
  server.on('upgrade', (req, socket, head) => {
    if (upgrade === 'refuse-503') {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    } else if (upgrade === 'drop') {
      socket.destroy();
    } else if (upgrade === 'answer') {
      wss.handleUpgrade(req, socket, head, (ws) =>
        ws.on('message', (raw) => {
          const { id } = JSON.parse(String(raw)) as { id: string };
          ws.send(JSON.stringify({ type: 'res', id, ok: true, payload: { served: true } }));
        }),
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    wss.close();
    server.close();
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closedPort(): Promise<string> {
  const server = http.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return `ws://127.0.0.1:${port}`;
}

class RuntimeWebSocket {
  constructor() {
    throw new Error('the CLI opened the runtime WebSocket');
  }
}

test(
  'gateway sockets use the ws client, not the Node runtime WebSocket',
  { timeout: 5000 },
  async (t) => {
    const url = await gateway(t, 'answer');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: RuntimeWebSocket });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, 'WebSocket', original);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
    });

    assert.deepEqual(await new GatewayClient({ url, timeout: 2000 }).call('gateway.status'), {
      served: true,
    });
    const connection = await new GatewayClient({ url, timeout: 2000 }).connect();
    assert.deepEqual(await connection.call('gateway.status'), { served: true });
    connection.close();
  },
);

for (const [name, target, reason] of [
  [
    'a 503 upgrade',
    (t: TestContext) => gateway(t, 'refuse-503'),
    /^Connection failed — is the gateway running\? \(Unexpected server response: 503\)$/,
  ],
  [
    'a dropped upgrade',
    (t: TestContext) => gateway(t, 'drop'),
    /^Connection failed — is the gateway running\? \(socket hang up\)$/,
  ],
  [
    'a closed port',
    () => closedPort(),
    /^Connection failed — is the gateway running\? \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
  ],
] as const) {
  test(
    `${name} fails both entry points with the transport reason`,
    { timeout: 5000 },
    async (t) => {
      const url = await target(t);
      for (const open of [
        () => new GatewayClient({ url, timeout: 2000 }).call('gateway.status'),
        () => new GatewayClient({ url, timeout: 2000 }).connect(),
      ]) {
        await assert.rejects(open(), (error: unknown) => {
          assert.ok(error instanceof GatewayConnectionError);
          assert.match(error.message, reason);
          return true;
        });
      }
    },
  );
}

test(
  'a gateway that never answers the upgrade times out both entry points',
  { timeout: 5000 },
  async (t) => {
    const url = await gateway(t, 'hang');
    for (const open of [
      () => new GatewayClient({ url, timeout: 200 }).call('gateway.status'),
      () => new GatewayClient({ url, timeout: 200 }).connect(),
    ]) {
      await assert.rejects(open(), (error: unknown) => {
        assert.ok(error instanceof GatewayConnectionError);
        assert.equal(error.message, 'Timeout — no activity for 200ms');
        return true;
      });
    }
  },
);

test('the failure reason lists every address tried and skips empty causes', () => {
  const hint = 'Connection failed — is the gateway running?';
  for (const [cause, message] of [
    [
      new AggregateError([
        new Error('connect ETIMEDOUT fe80::1:7801'),
        new Error('connect ECONNREFUSED 127.0.0.1:7801'),
      ]),
      `${hint} (connect ETIMEDOUT fe80::1:7801; connect ECONNREFUSED 127.0.0.1:7801)`,
    ],
    [new Error('socket hang up'), `${hint} (socket hang up)`],
    [new Error(''), hint],
    ['not an error', hint],
    [undefined, hint],
  ] as const) {
    assert.equal(connectionFailed(cause).message, message);
  }
});
