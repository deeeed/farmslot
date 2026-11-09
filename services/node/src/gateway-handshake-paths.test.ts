import { MINIMUM_RUNTIME_VERSION, RUNTIME_VERSION } from '@farmslot/agent-runtime/version';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { MINIMUM_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@farmslot/protocol';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { registerNode } from './gateway-handshake.js';

test('node registration transports the optional typed FarmPaths report unchanged', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'node-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = resolveFarmPaths({ role: 'node', home: root, checkoutRoot: root, env: {} });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const frame: unknown = JSON.parse(raw.toString());
      assert.ok(frame && typeof frame === 'object' && 'id' in frame && 'params' in frame);
      assert.ok(frame.params && typeof frame.params === 'object' && 'farmPaths' in frame.params);
      assert.deepEqual(frame.params.farmPaths, report);
      socket.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: {
            registered: true,
            protocolVersion: PROTOCOL_VERSION,
            minimumProtocolVersion: MINIMUM_PROTOCOL_VERSION,
            runtimeVersion: RUNTIME_VERSION,
            minimumRuntimeVersion: MINIMUM_RUNTIME_VERSION,
          },
        }),
      );
    }),
  );
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(() => client.terminate());
  await once(client, 'open');
  const registered = await registerNode(client, {
    machine: 'paths-node',
    pid: 1,
    capabilities: [],
    farmPaths: report,
  });
  assert.equal(registered.registered, true);
});
