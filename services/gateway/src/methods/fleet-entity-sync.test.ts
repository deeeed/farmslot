process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { Methods, type RequestFrame, type ResponseFrame } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { FLEET_ENTITY_PAGE_MAX_BYTES } = await import('./fleet-entity-sync.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');
const { setCachedFleetForTests } = await import('../fleet/state.js');

const TEST_TIMEOUT = { timeout: 15_000 };

test(
  'fleet.status versions and ids params keep fleet.status operator authorization',
  TEST_TIMEOUT,
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), 'fleet-entity-auth-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    // Seed the in-process fleet cache so fleetStatusVersions / fleetStatusIds don't
    // try to read pool files (which don't exist in the temp test home).
    setCachedFleetForTests({
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    });
    t.after(() => setCachedFleetForTests(null));
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    // fleet.status has classification 'admin' — requires the admin role.
    const admin = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'fleet-entity-admin' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const outsider = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'fleet-entity-outsider' },
      [],
    );
    const tokens = new Map(
      [admin, outsider].map((principal) => [
        principal.id,
        runtime.writer.issueCredential(principal.id, 'fleet-entity-proof').secret,
      ]),
    );
    const server = createServer();
    const wss = createWebSocketServer(server, runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const { port } = server.address() as { port: number };
    for (const [principal, allowed] of [
      [admin, true],
      [outsider, false],
    ] as const) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      t.after(() => ws.terminate());
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', (code) => reject(new Error(`socket closed before open (${code})`)));
      });
      const token = tokens.get(principal.id);
      assert.equal((await request(ws, Methods.AUTH_CONNECT, { clientKind: 'ui', token })).ok, true);
      for (const params of [{ versions: true }, { ids: ['missing-slot'] }]) {
        const reply = await request(ws, Methods.FLEET_STATUS, params);
        assert.equal(reply.ok, allowed, JSON.stringify(params));
        if (!allowed) assert.equal(reply.error?.code, 'AUTH_FORBIDDEN');
      }
      ws.close();
    }
  },
);

test('fleet entity ids page has a byte cap', TEST_TIMEOUT, () => {
  assert.equal(typeof FLEET_ENTITY_PAGE_MAX_BYTES, 'number');
  assert.ok(FLEET_ENTITY_PAGE_MAX_BYTES > 0, 'cap must be positive');
  assert.ok(FLEET_ENTITY_PAGE_MAX_BYTES <= 10 * 1024 * 1024, 'cap must be at most 10 MB');
});

let requestId = 0;
function request(ws: WebSocket, method: string, params: unknown): Promise<ResponseFrame> {
  const id = `fleet-entity-auth-${++requestId}`;
  const response = new Promise<ResponseFrame>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as ResponseFrame;
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
    ws.once('close', (code, reason) =>
      reject(new Error(`socket closed before ${method} replied (${code} ${reason.toString()})`)),
    );
  });
  const frame: RequestFrame = { type: 'req', id, method, params };
  ws.send(JSON.stringify(frame));
  return response;
}
