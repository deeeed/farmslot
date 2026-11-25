process.env.NODE_TEST_CONTEXT = '1';

// node.connect through the real WebSocket server: a second process for a connected machine is
// refused while the connected node answers its health check (any reply, a node error included);
// a stopping connected node is replaced and keeps its socket; a silent one is replaced and its
// socket closed without unregistering the new node; a newcomer that closes while it is admitted
// is not registered.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { Methods, type RequestFrame, type ResponseFrame } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { getNode } = await import('../fleet/machine-registry.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');

type Answer = 'ok' | 'error' | 'stopping' | 'silent';

/** A node client that answers the gateway's requests on its socket the given way. */
async function nodeClient(url: string, answer: Answer): Promise<WebSocket> {
  const ws = await connect(url);
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as RequestFrame;
    if (frame.type !== 'req' || answer === 'silent') return;
    const reply =
      answer === 'ok'
        ? { type: 'res', id: frame.id, ok: true, payload: { pid: 1 } }
        : {
            type: 'res',
            id: frame.id,
            ok: false,
            error:
              answer === 'stopping'
                ? { code: 'NODE_SHUTTING_DOWN', message: 'Node is shutting down.' }
                : { code: 'FIXTURE_UNSUPPORTED', message: 'This fixture runs no commands' },
          };
    ws.send(JSON.stringify(reply));
  });
  await request(ws, Methods.AUTH_CONNECT, { clientKind: 'node' });
  return ws;
}

for (const answer of ['ok', 'error'] as const) {
  test(
    `a second process is refused while the connected node answers (${answer})`,
    { timeout: 8000 },
    async () => {
      const harness = await startServer();
      try {
        const machine = `single-answer-${answer}`;
        const incumbent = await nodeClient(harness.url, answer);
        assert.equal((await request(incumbent, 'node.connect', { machine, pid: 1 })).ok, true);
        const newcomer = await nodeClient(harness.url, 'ok');
        const refused = await request(newcomer, 'node.connect', { machine, pid: 2 });
        assert.equal(refused.ok, false);
        assert.equal(refused.error?.code, 'NODE_ALREADY_CONNECTED');
        assert.match(refused.error?.message ?? '', /already connected \(pid 1\); refused pid 2/);
        assert.equal(getNode(machine)?.pid, 1);
        assert.equal(getNode(machine)?.lastRefusedDuplicate?.pid, 2);
        assert.equal(incumbent.readyState, WebSocket.OPEN);
      } finally {
        await harness.close();
      }
    },
  );
}

test('a stopping connected node is replaced and keeps its socket', { timeout: 8000 }, async () => {
  const harness = await startServer();
  try {
    const machine = 'single-stopping';
    const incumbent = await nodeClient(harness.url, 'stopping');
    assert.equal((await request(incumbent, 'node.connect', { machine, pid: 1 })).ok, true);
    const newcomer = await nodeClient(harness.url, 'ok');
    assert.equal((await request(newcomer, 'node.connect', { machine, pid: 2 })).ok, true);
    assert.equal(getNode(machine)?.pid, 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(incumbent.readyState, WebSocket.OPEN, 'its accepted commands can still close out');
  } finally {
    await harness.close();
  }
});

test(
  'a silent connected node is replaced and its socket closed without unregistering the new one',
  { timeout: 10000 },
  async () => {
    const harness = await startServer();
    try {
      const machine = 'single-silent';
      const incumbent = await nodeClient(harness.url, 'silent');
      assert.equal((await request(incumbent, 'node.connect', { machine, pid: 1 })).ok, true);
      const closed = new Promise<void>((resolve) => incumbent.once('close', () => resolve()));
      const newcomer = await nodeClient(harness.url, 'ok');
      assert.equal((await request(newcomer, 'node.connect', { machine, pid: 2 })).ok, true);
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(getNode(machine)?.pid, 2, "the old socket's close handler left the new node");
    } finally {
      await harness.close();
    }
  },
);

test(
  'a newcomer that closes while it is admitted is not registered',
  { timeout: 10000 },
  async () => {
    const harness = await startServer();
    try {
      const machine = 'single-closed-newcomer';
      const incumbent = await nodeClient(harness.url, 'silent');
      assert.equal((await request(incumbent, 'node.connect', { machine, pid: 1 })).ok, true);
      const newcomer = await nodeClient(harness.url, 'ok');
      newcomer.send(
        JSON.stringify({
          type: 'req',
          id: 'closing-connect',
          method: 'node.connect',
          params: { machine, pid: 2 },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      newcomer.close();
      // Past the 3 s probe budget: the admission finds the newcomer gone and registers nothing.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      assert.equal(getNode(machine)?.pid, 1);
      assert.equal(
        incumbent.readyState,
        WebSocket.OPEN,
        'the connected node is not closed for nothing',
      );
    } finally {
      await harness.close();
    }
  },
);

async function startServer() {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-node-single-'));
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

let requestId = 0;
async function request(ws: WebSocket, method: string, params: unknown): Promise<ResponseFrame> {
  const id = `node-single-${++requestId}`;
  const response = new Promise<ResponseFrame>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as ResponseFrame;
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
  });
  const frame: RequestFrame = { type: 'req', id, method, params };
  ws.send(JSON.stringify(frame));
  return response;
}
