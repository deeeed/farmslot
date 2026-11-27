import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { ActionExecutionContext } from '../src/core/types.js';
import { CdpSession, CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';

const SCUTTLED =
  'Error: LavaMoat - property "requestAnimationFrame" of globalThis is inaccessible under scuttling mode.';

// A MetaMask Extension page under LavaMoat scuttling: main-world evaluations that
// touch page globals throw; an isolated world has real ones.
test('app.hud renders and clears from an isolated world on a scuttled page', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const evaluations: Array<{ contextId?: number; hud: boolean }> = [];
  server.on('connection', (client) => {
    client.on('message', (data) => {
      const request = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params?: { expression?: string; contextId?: number };
      };
      const reply = (result: unknown) => client.send(JSON.stringify({ id: request.id, result }));
      if (request.method === 'Page.getFrameTree')
        return reply({ frameTree: { frame: { id: 'main' } } });
      if (request.method === 'Page.createIsolatedWorld') return reply({ executionContextId: 7 });
      const expression = String(request.params?.expression ?? '');
      const hud = expression.includes('farmslot-recipe-hud');
      evaluations.push({ contextId: request.params?.contextId, hud });
      if (request.params?.contextId === undefined) {
        return reply({
          exceptionDetails: { text: 'Uncaught', exception: { description: SCUTTLED } },
        });
      }
      return reply({
        result: {
          value: expression.includes('cleared') ? { hud: false, cleared: true } : { hud: true },
        },
      });
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
  const shown = await transport.execute(
    'app.hud',
    { intent: 'The footer remains visible.' },
    context,
  );
  assert.match(JSON.stringify(shown), /"hud":true/u);
  const cleared = await transport.execute('app.hud', { clear: true }, context);
  assert.match(JSON.stringify(cleared), /"cleared":true/u);
  const hudEvaluations = evaluations.filter((evaluation) => evaluation.hud);
  assert.equal(hudEvaluations.length, 2);
  assert.ok(hudEvaluations.every((evaluation) => evaluation.contextId === 7));
});

// A navigation late in the budget retries in a new world, within the same 10 s.
test(
  'app.hud keeps one 10 s budget across an isolated-world retry',
  { timeout: 5_000 },
  async (t) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    t.after(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const evaluated: Array<() => void> = [];
    let firstEvaluation: { id: number; send: (data: string) => void } | undefined;
    server.on('connection', (client) => {
      client.on('message', (data) => {
        const request = JSON.parse(String(data)) as { id: number; method: string };
        const reply = (result: unknown) => client.send(JSON.stringify({ id: request.id, result }));
        if (request.method === 'Page.getFrameTree')
          return reply({ frameTree: { frame: { id: 'main' } } });
        if (request.method === 'Page.createIsolatedWorld') return reply({ executionContextId: 7 });
        // Hold every evaluation: the first fails transiently on demand, the retry never answers.
        if (!firstEvaluation) firstEvaluation = { id: request.id, send: (raw) => client.send(raw) };
        evaluated.shift()?.();
        return undefined;
      });
    });
    const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
    t.after(() => session.close());
    const page = new CdpWebPage(session);
    const transport = createCdpWebUiTransport({ withPage: (_input, use) => use(page) });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const reached = () => new Promise<void>((resolve) => evaluated.push(resolve));
    const first = reached();
    const pending = transport.execute(
      'app.hud',
      { intent: 'The footer remains visible.' },
      {
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
      },
    );
    const rejected = assert.rejects(pending, /timed out after 1000ms/u);
    await first;
    t.mock.timers.tick(9_000);
    const retry = reached();
    assert.ok(firstEvaluation);
    firstEvaluation.send(
      JSON.stringify({
        id: firstEvaluation.id,
        error: { code: -32000, message: 'Cannot find context with specified id' },
      }),
    );
    await retry;
    t.mock.timers.tick(1_000);
    await rejected;
  },
);
