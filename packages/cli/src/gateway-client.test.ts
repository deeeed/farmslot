import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test, { type TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import {
  cliReconnectWindowMs,
  connectionFailed,
  GATEWAY_RECONNECT_WINDOW_MS,
  GatewayClient,
  GatewayConnectionError,
} from './gateway-client.js';

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

test(
  'a one-shot call ignores frames that arrive after its result',
  { timeout: 5000 },
  async (t) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    t.after(() => wss.close());
    // The event goes out right behind the result, before the client's close reaches the server.
    const serverClosed = new Promise<void>((resolve) =>
      wss.on('connection', (ws) => {
        ws.on('close', () => resolve());
        ws.on('message', (raw) => {
          const { id } = JSON.parse(String(raw)) as { id: string };
          ws.send(JSON.stringify({ type: 'res', id, ok: true, payload: { served: true } }));
          ws.send(JSON.stringify({ type: 'event', event: 'fleet.updated', payload: {} }));
        });
      }),
    );
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const events: unknown[] = [];
    const result = await new GatewayClient({ url, timeout: 2000 }).callWithEvents(
      'gateway.status',
      {},
      (event) => events.push(event),
    );
    assert.deepEqual(result, { served: true });
    await serverClosed;
    assert.deepEqual(events, []);
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

/** Starts answering on a refused port after `afterMs`, as a reloaded gateway does. */
async function reloadingGateway(t: TestContext, afterMs: number) {
  const url = await closedPort();
  const requests: string[] = [];
  let wss: WebSocketServer | undefined;
  const timer = setTimeout(() => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: Number(new URL(url).port) });
    wss.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const { id, method } = JSON.parse(String(raw)) as { id: string; method: string };
        requests.push(method);
        ws.send(JSON.stringify({ type: 'res', id, ok: true, payload: { served: true } }));
      }),
    );
  }, afterMs);
  t.after(() => {
    clearTimeout(timer);
    for (const client of wss?.clients ?? []) client.terminate();
    wss?.close();
  });
  return { url, requests };
}

const waiting = (url: string) =>
  new GatewayClient({ url, timeout: 2000, reconnectWindowMs: 10_000 });

test('a one-shot call waits out a gateway reload and reaches it once it listens', async (t) => {
  const { url, requests } = await reloadingGateway(t, 600);
  assert.deepEqual(await waiting(url).call('fleet.status'), { served: true });
  // The request reached the gateway once.
  assert.deepEqual(requests, ['fleet.status']);
});

test('a long-lived connection waits out a gateway reload too', async (t) => {
  const { url, requests } = await reloadingGateway(t, 600);
  const connection = await waiting(url).connect();
  t.after(() => connection.close());
  assert.deepEqual(await connection.call('gateway.status'), { served: true });
  assert.deepEqual(requests, ['gateway.status']);
});

test('a reload that outlasts the wait fails with the transport reason', async (t) => {
  const notices: string[] = [];
  t.mock.method(process.stderr, 'write', (text: string) => {
    notices.push(text);
    return true;
  });
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
  });
  const url = await closedPort();
  const started = Date.now();
  await assert.rejects(
    new GatewayClient({ url, timeout: 2000, reconnectWindowMs: 700 }).call('gateway.status'),
    (error: unknown) =>
      error instanceof GatewayConnectionError &&
      /^Connection failed — is the gateway running\? \(connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/.test(
        error.message,
      ),
  );
  assert.ok(Date.now() - started >= 250, 'it retried before giving up');
  assert.ok(Date.now() - started < 2000, 'the wait is bounded');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /not accepting connections \(reloading\?\); retrying for up to 1s/);
});

const personSession = {
  refreshToken: 'fsr_' + 'a'.repeat(32) + '_' + 'r'.repeat(43),
  session: {
    id: 'a'.repeat(32),
    principalId: 'person',
    principalGeneration: 0,
    deviceName: 'Fixture',
    deviceKind: 'cli' as const,
    createdAt: '2026-10-16T00:00:00.000Z',
    lastRefreshedAt: '2026-10-16T00:00:00.000Z',
    refreshExpiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
  },
};

test('a person-session token refresh shares the command wait', async (t) => {
  const notices: string[] = [];
  t.mock.method(process.stderr, 'write', (text: string) => {
    notices.push(text);
    return true;
  });
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
  });
  const url = await closedPort();
  for (const open of [
    (client: GatewayClient) => client.connect(),
    (client: GatewayClient) => client.call('fleet.status'),
  ]) {
    notices.length = 0;
    const client = new GatewayClient({
      url,
      timeout: 2000,
      reconnectWindowMs: 1500,
      credential: { personSession: structuredClone(personSession) },
    });
    const started = Date.now();
    await assert.rejects(open(client), GatewayConnectionError);
    // A refresh with its own window would stack a second wait and notice inside the first.
    assert.equal(notices.length, 1);
    assert.ok(Date.now() - started < 2500, 'one window bounds the wait');
  }
});

test('only farmslot commands wait, for FARMSLOT_GATEWAY_RECONNECT_MS or 90 s', async () => {
  assert.equal(cliReconnectWindowMs({}), GATEWAY_RECONNECT_WINDOW_MS);
  assert.equal(GATEWAY_RECONNECT_WINDOW_MS, 90_000);
  assert.equal(cliReconnectWindowMs({ FARMSLOT_GATEWAY_RECONNECT_MS: '0' }), 0);
  assert.equal(cliReconnectWindowMs({ FARMSLOT_GATEWAY_RECONNECT_MS: '5000' }), 5000);
  assert.equal(cliReconnectWindowMs({ FARMSLOT_GATEWAY_RECONNECT_MS: 'soon' }), 90_000);
  // A client built without a window, as probes and scripts build it, fails at once.
  const url = await closedPort();
  const started = Date.now();
  await assert.rejects(new GatewayClient({ url, timeout: 2000 }).call('gateway.status'));
  assert.ok(Date.now() - started < 200);
});

test('a failure after the socket opened is not retried, so no request is sent twice', async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(() => wss.close());
  let requests = 0;
  wss.on('connection', (ws) =>
    ws.on('message', () => {
      requests += 1;
      ws.terminate();
    }),
  );
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  await assert.rejects(
    new GatewayClient({ url, timeout: 2000, reconnectWindowMs: 10_000 }).call('run.create'),
    (error: unknown) => error instanceof GatewayConnectionError && !error.reconnectable,
  );
  assert.equal(requests, 1);
});

test('only a reload-shaped failure before the socket opens is worth waiting for', () => {
  for (const [cause, beforeOpen, reconnectable] of [
    [new Error('connect ECONNREFUSED 127.0.0.1:7801'), true, true],
    [new Error('Unexpected server response: 503'), true, true],
    [new Error('socket hang up'), true, true],
    [
      new AggregateError([
        new Error('connect ECONNREFUSED ::1:7801'),
        new Error('connect ECONNREFUSED 127.0.0.1:7801'),
      ]),
      true,
      true,
    ],
    // A wrong host, a timeout or a refused credential will not fix itself.
    [new Error('getaddrinfo ENOTFOUND gateway.invalid'), true, false],
    [new Error('connect ETIMEDOUT 10.0.0.9:7801'), true, false],
    [new Error('Unexpected server response: 401'), true, false],
    [
      new AggregateError([
        new Error('connect ETIMEDOUT fe80::1:7801'),
        new Error('connect ECONNREFUSED 127.0.0.1:7801'),
      ]),
      true,
      false,
    ],
    [new Error('connect ECONNREFUSED 127.0.0.1:7801'), false, false],
    [undefined, true, false],
  ] as const)
    assert.equal(connectionFailed(cause, beforeOpen).reconnectable, reconnectable, String(cause));
});
