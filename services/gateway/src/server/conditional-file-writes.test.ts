process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  type GatewayAuthConnectResult,
  Methods,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { getAllNodes, getNode } = await import('../fleet/machine-registry.js');
const { sendNodeRequest } = await import('../fleet/node-rpc.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');

test(
  'connect advertises conditional file writes and stores the node flag',
  { timeout: 4000 },
  async () => {
    const harness = await startServer();
    try {
      const ui = await connect(harness.url);
      const auth = await request(ui, Methods.AUTH_CONNECT, { clientKind: 'ui' });
      assert.equal(
        (auth.payload as GatewayAuthConnectResult).capabilities.conditionalFileWrites,
        true,
      );
      ui.close();

      for (const conditionalWrites of [true, undefined]) {
        const machine = `conditional-flag-${conditionalWrites}`;
        const node = await connect(harness.url);
        await request(node, Methods.AUTH_CONNECT, { clientKind: 'node' });
        const registered = await request(node, 'node.connect', {
          machine,
          pid: 1,
          ...(conditionalWrites ? { conditionalWrites } : {}),
        });
        assert.equal(registered.ok, true);
        assert.equal(getNode(machine)?.conditionalWrites, conditionalWrites);
        assert.equal(
          getAllNodes().find((entry) => entry.machine === machine)?.conditionalWrites,
          conditionalWrites,
        );
        node.close();
      }
    } finally {
      await harness.close();
    }
  },
);

test(
  'a node refusal keeps its error details on the way to the gateway',
  { timeout: 4000 },
  async () => {
    const harness = await startServer();
    const machine = 'conditional-details-node';
    try {
      const node = await connect(harness.url);
      await request(node, Methods.AUTH_CONNECT, { clientKind: 'node' });
      await request(node, 'node.connect', { machine, pid: 1, conditionalWrites: true });
      const details = { reason: 'hash', currentHash: 'a'.repeat(64) };
      node.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as RequestFrame;
        if (frame.type !== 'req' || frame.method !== 'fs.write') return;
        const reply: ResponseFrame = {
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'FS_CONFLICT', message: 'The file changed since it was read', details },
        };
        node.send(JSON.stringify(reply));
      });
      await assert.rejects(
        sendNodeRequest(getNode(machine)!, 'fs.write', {
          root: '/repo',
          relPath: 'a.txt',
          content: 'x',
          expectedHash: 'stale',
        }),
        { code: 'FS_CONFLICT', details },
      );
      node.close();
    } finally {
      await harness.close();
    }
  },
);

async function startServer() {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-conditional-writes-'));
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
  const id = `conditional-test-${++requestId}`;
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
