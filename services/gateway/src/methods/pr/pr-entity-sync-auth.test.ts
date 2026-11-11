process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { Methods, type RequestFrame, type ResponseFrame } from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { resetPRListCacheForTests } = await import('./list-cache.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../security/auth.js');
const { createWebSocketServer } = await import('../../server.js');

const TEST_TIMEOUT = { timeout: 15_000 };

test(
  'pr.list versions and ids params keep pr.list admin authorization',
  TEST_TIMEOUT,
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-entity-auth-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));

    // Prevent disk cache loading; no snapshot is seeded — admin will get NOT_READY,
    // confirming authorization passed and the method body was reached.
    resetPRListCacheForTests();
    t.after(() => resetPRListCacheForTests());

    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });

    // pr.list has classification 'admin' — requires the admin role.
    const admin = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'pr-entity-admin' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const outsider = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'pr-entity-outsider' },
      [],
    );
    const tokens = new Map(
      [admin, outsider].map((p) => [
        p.id,
        runtime.writer.issueCredential(p.id, 'pr-entity-proof').secret,
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

    for (const [principal, role] of [
      [admin, 'admin'],
      [outsider, 'outsider'],
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

      // Plain pr.list, versions, and ids — all share the same authorization gate.
      const paramsSet = [
        { versions: true as const },
        { ids: ['org/repo/1'] },
        { versions: true as const, project: 'myproject' }, // project-scoped: same auth
        { ids: ['org/repo/1'], project: 'myproject' },
      ];

      for (const params of paramsSet) {
        const reply = await request(ws, Methods.PR_LIST, params);
        if (role === 'outsider') {
          assert.equal(reply.ok, false, `outsider must be denied for ${JSON.stringify(params)}`);
          assert.equal(
            reply.error?.code,
            'AUTH_FORBIDDEN',
            `outsider must get AUTH_FORBIDDEN for ${JSON.stringify(params)}`,
          );
        } else {
          // Admin reaches the method body — gets NOT_READY (no snapshot loaded),
          // not AUTH_FORBIDDEN, proving the authorization gate admitted them.
          assert.equal(
            reply.ok,
            false,
            `admin gets NOT_READY (no snapshot) for ${JSON.stringify(params)}`,
          );
          assert.notEqual(
            reply.error?.code,
            'AUTH_FORBIDDEN',
            `admin must not get AUTH_FORBIDDEN for ${JSON.stringify(params)}`,
          );
        }
      }

      ws.close();
    }
  },
);

test(
  'pr.list param validation: bad versions and bad ids return INVALID_PARAMS',
  TEST_TIMEOUT,
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-param-valid-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    resetPRListCacheForTests();
    t.after(() => resetPRListCacheForTests());
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const admin = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'pr-param-admin' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const token = runtime.writer.issueCredential(admin.id, 'pr-param-proof').secret;
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`closed before open (${code})`)));
    });
    assert.equal((await request(ws, Methods.AUTH_CONNECT, { clientKind: 'ui', token })).ok, true);

    for (const [params, label] of [
      [{ versions: 'yes' }, 'versions: "yes"'],
      [{ ids: 'x' }, 'ids: "x"'],
      [{ ids: [1] }, 'ids: [1]'],
    ] as const) {
      const reply = await request(ws, Methods.PR_LIST, params);
      assert.equal(reply.ok, false, `${label} must fail`);
      assert.equal(reply.error?.code, 'INVALID_PARAMS', `${label} must give INVALID_PARAMS`);
    }
    ws.close();
  },
);

test(
  'fleet.status param validation: bad versions and bad ids return INVALID_PARAMS',
  TEST_TIMEOUT,
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), 'fleet-param-valid-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    // Fleet status needs seeded cache so the method body runs for valid params.
    const { setCachedFleetForTests } = await import('../../fleet/state.js');
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
    const admin = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'fleet-param-admin' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const token = runtime.writer.issueCredential(admin.id, 'fleet-param-proof').secret;
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`closed before open (${code})`)));
    });
    assert.equal((await request(ws, Methods.AUTH_CONNECT, { clientKind: 'ui', token })).ok, true);

    for (const [params, label] of [
      [{ versions: 'yes' }, 'versions: "yes"'],
      [{ ids: 'x' }, 'ids: "x"'],
      [{ ids: [1] }, 'ids: [1]'],
    ] as const) {
      const reply = await request(ws, Methods.FLEET_STATUS, params);
      assert.equal(reply.ok, false, `${label} must fail`);
      assert.equal(reply.error?.code, 'INVALID_PARAMS', `${label} must give INVALID_PARAMS`);
    }
    ws.close();
  },
);

let requestId = 0;
function request(ws: WebSocket, method: string, params: unknown): Promise<ResponseFrame> {
  const id = `pr-entity-auth-${++requestId}`;
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
