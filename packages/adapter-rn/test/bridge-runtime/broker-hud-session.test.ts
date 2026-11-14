import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

interface HudSession {
  send(command: string, args: string[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}
interface BridgeCore {
  createBrokerHudSession(socketPath: string, env: Record<string, string>): HudSession;
}
interface Target {
  deviceId: string;
  name: string;
  generation: number;
}
interface Request {
  id: number;
  deviceId: string;
  action: string;
  params: { nameIncludes?: string; step?: unknown };
}
const require = createRequire(import.meta.url);
const { createBrokerHudSession } = require('../../bridge-runtime/bridge-core.cjs') as BridgeCore;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-session-'));
  const socketPath = path.join(root, 'broker.sock');
  const sockets = new Set<net.Socket>();
  const requests: Request[] = [];
  const targets: Target[] = [{ deviceId: 'device-1', name: 'phone-1', generation: 1 }];
  const state = { connections: 0, targets, stall: false };
  const server = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as Request;
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        if (request.action === 'resolve-targets') {
          socket.write(JSON.stringify({ id: request.id, result: state.targets }) + '\n');
        } else if (request.action === 'hud-update' && !state.stall) {
          socket.write(
            JSON.stringify({
              id: request.id,
              result: { status: 'queued', version: requests.length },
            }) + '\n',
          );
        }
      }
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const session = createBrokerHudSession(socketPath, { IOS_SIMULATOR: 'phone-1' });
  cleanups.push(() => session.close());
  const show = () =>
    session.send('show-step-json-deferred', [
      JSON.stringify({ intent: 'Observe Perps', id: 'n1' }),
    ]);
  return { state, requests, session, show };
}

test('reuses two broker sockets while resolving the target for every deferred update', async () => {
  const { state, requests, session, show } = await fixture();
  await show();
  await session.send('hide-step-deferred', []);
  assert.equal(state.connections, 2);
  assert.deepEqual(
    requests.map((r) => r.action),
    ['resolve-targets', 'hud-update', 'resolve-targets', 'hud-update'],
  );
  assert.deepEqual(
    requests.filter((r) => r.action === 'hud-update').map((r) => [r.deviceId, r.params.step]),
    [
      ['device-1', { intent: 'Observe Perps', id: 'n1' }],
      ['device-1', null],
    ],
  );
  assert.ok(
    requests
      .filter((r) => r.action === 'resolve-targets')
      .every((r) => r.params.nameIncludes === 'phone-1'),
  );
  await session.close();
  await assert.rejects(show, /session is closed/);
});

test('replaces the selected connection after runtime generation changes', async () => {
  const { state, show } = await fixture();
  await show();
  state.targets[0].generation++;
  await show();
  assert.equal(state.connections, 3);
});

test('refuses missing or ambiguous selected targets before sending the HUD update', async () => {
  const { state, requests, show } = await fixture();
  state.targets = [];
  await assert.rejects(show, { code: 'NO_TARGET' });
  state.targets = [
    { deviceId: 'one', name: 'phone-1', generation: 1 },
    { deviceId: 'two', name: 'phone-1-copy', generation: 1 },
  ];
  await assert.rejects(show, /requires one target; found 2/);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 0);
});

test('bounds a stalled update and never replays it after an indeterminate response', async () => {
  const { state, requests, session } = await fixture();
  state.stall = true;
  await assert.rejects(() => session.send('hide-step-deferred', [], 200), /timeout/);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 1);
});

test('preserves payload validation and rejects synchronous capture commands', async () => {
  const { session, requests } = await fixture();
  await assert.rejects(() => session.send('show-step-json-deferred', ['{}']), /step.intent/);
  await assert.rejects(() => session.send('show-step-json', ['{}']), /Not a deferred HUD command/);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 0);
});
