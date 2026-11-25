import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';

import { WebSocketServer } from 'ws';

import { waitForHudPaint } from '@farmslot/protocol/recipe';

import type { ActionExecutionContext } from '../src/core/types.js';
import {
  CdpSession,
  CdpWebPage,
  createCdpWebUiTransport,
  SCUTTLE_SAFE_NEXT_FRAME,
} from '../src/runtime/cdp.js';

test('the HUD paint wait degrades to a timer on a scuttled page', async (t) => {
  // A MetaMask Extension page under LavaMoat scuttling: reading the global throws.
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    get() {
      throw new Error(
        'LavaMoat - property "requestAnimationFrame" of globalThis is inaccessible under scuttling mode.',
      );
    },
  });
  t.after(() => Reflect.deleteProperty(globalThis, 'requestAnimationFrame'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paint: Promise<void> = vm.runInThisContext(
    `(${waitForHudPaint.toString()})(${SCUTTLE_SAFE_NEXT_FRAME})`,
  );
  // Two fallback frames settle the wait long before its 500 ms "did not paint" timer.
  t.mock.timers.tick(16);
  t.mock.timers.tick(16);
  await paint;
  assert.throws(
    () => vm.runInThisContext(`(${waitForHudPaint.toString()})(requestAnimationFrame)`),
    /inaccessible under scuttling mode/u,
  );
});

test('the next frame still uses requestAnimationFrame where the page allows it', async () => {
  const calls: number[] = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: () => void) => {
      calls.push(1);
      return setTimeout(callback, 0);
    },
  });
  await vm.runInContext(`(${waitForHudPaint.toString()})(${SCUTTLE_SAFE_NEXT_FRAME})`, context);
  assert.equal(calls.length, 2);
});

test('app.hud never reads the bare requestAnimationFrame global', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const expressions: string[] = [];
  server.on('connection', (client) => {
    client.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: number; params?: { expression?: string } };
      expressions.push(String(request.params?.expression ?? ''));
      client.send(JSON.stringify({ id: request.id, result: { result: { value: { hud: true } } } }));
    });
  });
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());
  const page = new CdpWebPage(session);
  const transport = createCdpWebUiTransport({ withPage: (_input, use) => use(page) });
  const context: ActionExecutionContext = {
    nodeId: 'hud',
    recipe: {},
    projectRoot: '.',
    artifactsDir: '.',
    env: {},
    signal: new AbortController().signal,
    outputs: new Map(),
    getOutput: () => undefined,
    resolveProjectPath: (file) => file,
    resolveArtifactPath: (file) => file,
    getRunFileOffset: () => undefined,
    registerArtifact: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  await transport.execute('app.hud', { intent: 'The footer remains visible.' }, context);
  const hud = expressions.find(
    (expression) =>
      expression.includes('waitForHudPaint') || expression.includes('HUD did not paint'),
  );
  assert.ok(hud, 'app.hud evaluated a paint wait');
  assert.ok(hud.includes(SCUTTLE_SAFE_NEXT_FRAME));
  assert.doesNotMatch(hud, /\)\(requestAnimationFrame\)/u);
});
