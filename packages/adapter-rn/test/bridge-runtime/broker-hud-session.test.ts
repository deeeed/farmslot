import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';

interface HudSession {
  send(command: string, args: string[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}
interface BridgeCore {
  createBrokerHudSession(socketPath: string, env: Record<string, string>): HudSession;
  createBrokerCommandSession(socketPath: string, env: Record<string, string>): HudSession;
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
  method?: string;
  params: {
    nameIncludes?: string;
    step?: unknown;
    expression?: string;
    arguments?: { value: unknown }[];
  };
}
const require = createRequire(import.meta.url);
const { createBrokerHudSession, createBrokerCommandSession } =
  require('../../bridge-runtime/bridge-core.cjs') as BridgeCore;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(commandSession = false, env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-session-'));
  const socketPath = path.join(root, 'broker.sock');
  const sockets = new Set<net.Socket>();
  const requests: Request[] = [];
  const targets: Target[] = [{ deviceId: 'device-1', name: 'phone-1', generation: 1 }];
  const app = { route: { name: 'WalletView' }, mutations: 0 };
  const runtime = vm.createContext({
    app,
    __AGENTIC__: { platform: 'ios', getRoute: () => app.route },
  });
  const state = { connections: 0, targets, stall: false, dropEvaluationReply: '' };
  const onConnection = (socket: net.Socket) => {
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
        if (request.method === 'Runtime.evaluate') {
          const expression = request.params.expression ?? '';
          let result;
          try {
            result =
              expression === 'globalThis'
                ? { result: { objectId: 'global-object' } }
                : { result: { value: vm.runInContext(expression, runtime) } };
          } catch (error) {
            result = {
              exceptionDetails: { text: error instanceof Error ? error.message : String(error) },
            };
          }
          if (!state.dropEvaluationReply || !expression.includes(state.dropEvaluationReply)) {
            socket.write(JSON.stringify({ id: request.id, result }) + '\n');
          }
        } else if (request.method === 'Runtime.callFunctionOn') {
          socket.write(
            JSON.stringify({ id: request.id, result: { result: { value: true } } }) + '\n',
          );
        } else if (request.action === 'resolve-targets') {
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
  };
  let server = net.createServer(onConnection);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const restart = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = net.createServer(onConnection);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  };
  const session = (commandSession ? createBrokerCommandSession : createBrokerHudSession)(
    socketPath,
    { IOS_SIMULATOR: 'phone-1', ...env },
  );
  cleanups.push(() => session.close());
  const show = () =>
    session.send('show-step-json-deferred', [
      JSON.stringify({ intent: 'Observe Perps', id: 'n1' }),
    ]);
  return { state, requests, session, show, restart, socketPath, app };
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

test('replaces cached sockets when the broker restarts with the same target generation', async () => {
  const { state, requests, session, show, restart } = await fixture();
  await show();
  await restart();
  await session.send('hide-step-deferred', [], 200);
  assert.equal(state.connections, 4);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 2);
});

test('reports a disappearing broker socket as an unavailable target without submitting an update', async () => {
  const { socketPath, session, show, requests } = await fixture();
  await show();
  await unlink(socketPath);
  await assert.rejects(() => session.send('hide-step-deferred', [], 200), { code: 'NO_TARGET' });
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 1);
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

test('expires a queued update independently and never submits it after its deadline', async () => {
  const { state, requests, session } = await fixture();
  state.stall = true;
  const order: string[] = [];
  const first = session.send('hide-step-deferred', [], 250).catch((error: Error) => {
    order.push('first');
    return error;
  });
  const second = session.send('hide-step-deferred', [], 25).catch((error: Error) => {
    order.push('second');
    return error;
  });
  const [firstError, secondError] = await Promise.all([first, second]);
  assert.ok(firstError instanceof Error && /timeout/.test(firstError.message));
  assert.ok(secondError instanceof Error && /timeout/.test(secondError.message));
  assert.deepEqual(order, ['second', 'first']);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 1);
});

test('preserves payload validation and rejects synchronous capture commands', async () => {
  const { session, requests } = await fixture();
  await assert.rejects(() => session.send('show-step-json-deferred', ['{}']), /step.intent/);
  await assert.rejects(() => session.send('show-step-json', ['{}']), /Not a deferred HUD command/);
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 0);
});

test('ordinary commands reuse connections but read fresh target and route state each time', async () => {
  const { state, requests, session, app } = await fixture(true);
  assert.deepEqual(await session.send('get-route', []), { name: 'WalletView' });
  app.route = { name: 'PerpsMarketListView' };
  assert.deepEqual(await session.send('get-route', []), app.route);
  assert.equal(state.connections, 2);
  assert.equal(requests.filter((r) => r.action === 'resolve-targets').length, 2);
  assert.deepEqual(
    requests.filter((r) => r.method === 'Runtime.evaluate').map((r) => r.params.expression),
    [
      '(function() { return (globalThis.__AGENTIC__?.platform); })()',
      '(function() { return (globalThis.__AGENTIC__?.getRoute()); })()',
      '(function() { return (globalThis.__AGENTIC__?.platform); })()',
      '(function() { return (globalThis.__AGENTIC__?.getRoute()); })()',
    ],
  );
});

test('ordinary evaluations preserve values, async completion and exception failures', async () => {
  const { session } = await fixture(true);
  assert.deepEqual(await session.send('eval', ['({ count: 2 })']), { count: 2 });
  assert.equal(await session.send('eval', ['undefined']), undefined);
  assert.deepEqual(await session.send('eval-async', ['Promise.resolve({ count: 3 })']), {
    count: 3,
  });
  await assert.rejects(
    () => session.send('eval', ['(() => { throw new Error("failed read"); })()']),
    /failed read/,
  );
  await assert.rejects(
    () => session.send('navigate', ['WalletView']),
    /Unsupported broker session command/,
  );
});

test('synchronous HUD commands keep their acknowledged CDP calls instead of deferred controls', async () => {
  const { session, requests } = await fixture(true);
  const step = { intent: 'Observe Perps', id: 'n1' };
  assert.deepEqual(await session.send('show-step-json', [JSON.stringify(step)]), { ok: true });
  assert.deepEqual(await session.send('hide-step', []), { ok: true });
  assert.deepEqual(
    requests.filter((r) => r.method === 'Runtime.callFunctionOn').map((r) => r.params.arguments),
    [[{ value: step }], [{ value: null }]],
  );
  assert.equal(requests.filter((r) => r.action === 'hud-update').length, 0);
});

test('ordinary commands replace stale sockets and refuse ambiguous targets', async () => {
  const { session, state, restart } = await fixture(true);
  await session.send('get-route', []);
  state.targets[0].generation++;
  await session.send('get-route', []);
  assert.equal(state.connections, 3);
  await restart();
  await session.send('get-route', []);
  assert.equal(state.connections, 5);
  state.targets.push({ deviceId: 'two', name: 'phone-1-copy', generation: 1 });
  await assert.rejects(() => session.send('eval', ['1']), /requires one target; found 2/);
});

test('an indeterminate evaluation is never replayed and later independent commands remain usable', async () => {
  const { session, state, app } = await fixture(true);
  state.dropEvaluationReply = 'app.mutations';
  await assert.rejects(() => session.send('eval', ['++app.mutations'], 100), /timeout/);
  state.dropEvaluationReply = '';
  await session.send('get-route', []);
  assert.equal(app.mutations, 1);
});

test('ordinary sessions retain the configured asynchronous evaluation timeout', async () => {
  const { session } = await fixture(true, { CDP_TIMEOUT: '50' });
  await assert.rejects(
    () => session.send('eval-async', ['new Promise(() => {})'], 2000),
    /timed out after 50ms/,
  );
});
