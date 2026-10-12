import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { ActionExecutionContext } from '../src/core/types.js';
import { CdpSession, CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';

for (const mode of ['suspended', 'cancelled', 'complete', 'busy'] as const) {
  test(`CDP HUD evaluation has bounded cleanup: ${mode}`, async (t) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    t.after(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let requestId = 0;
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    t.after(() => {
      if (replyTimer) clearTimeout(replyTimer);
    });
    const received = new Promise<void>((resolve) => {
      server.on('connection', (client) => {
        client.on('message', (data) => {
          const request = JSON.parse(String(data)) as { id: number; method: string };
          assert.equal(request.method, 'Runtime.evaluate');
          requestId = request.id;
          if (mode === 'complete') {
            client.send(
              JSON.stringify({ id: request.id, result: { result: { value: { hud: true } } } }),
            );
          } else if (mode === 'busy') {
            replyTimer = setTimeout(() => {
              client.send(
                JSON.stringify({ id: request.id, result: { result: { value: { hud: true } } } }),
              );
            }, 850);
          } else if (mode === 'cancelled' && request.id > 1) {
            client.send(
              JSON.stringify({ id: request.id, result: { result: { value: { healthy: true } } } }),
            );
          }
          resolve();
        });
      });
    });
    const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
    t.after(() => session.close());
    const page = new CdpWebPage(session);
    const transport = createCdpWebUiTransport({ withPage: (_input, use) => use(page) });
    const controller = new AbortController();
    if (mode === 'suspended') t.mock.timers.enable({ apis: ['setTimeout'] });
    const context: ActionExecutionContext = {
      nodeId: 'hud',
      recipe: {},
      projectRoot: '.',
      artifactsDir: '.',
      env: {},
      signal: controller.signal,
      outputs: new Map(),
      getOutput: () => undefined,
      resolveProjectPath: (file) => file,
      resolveArtifactPath: (file) => file,
      getRunFileOffset: () => undefined,
      registerArtifact: () => {},
      logger: { info() {}, warn() {}, error() {} },
    };
    const pending = transport.execute(
      'app.hud',
      { intent: 'The footer remains visible.' },
      context,
    );
    if (mode === 'suspended') {
      const rejected = assert.rejects(pending, /CDP Runtime.evaluate timed out after 10000ms/);
      await received;
      t.mock.timers.tick(10_000);
      await rejected;
    } else if (mode === 'cancelled') {
      await received;
      const reason = new Error('Recipe cancelled during HUD paint.');
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
      // A late reply cannot revive a cancelled call or close another caller's socket.
      for (const client of server.clients)
        client.send(JSON.stringify({ id: requestId, result: {} }));
      const reply = await session.call('Runtime.evaluate', {}, { timeoutMs: 500 });
      assert.deepEqual(reply, { result: { value: { healthy: true } } });
      assert.equal(server.clients.size, 1);
    } else {
      assert.deepEqual(await pending, { hud: true });
      controller.abort(new Error('Cancellation after completion'));
    }
  });
}
