import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { ActionExecutionContext } from '../src/core/types.js';
import { CdpSession, CdpWebPage, createCdpWebUiTransport } from '../src/runtime/cdp.js';

for (const mode of ['suspended', 'cancelled', 'complete'] as const) {
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
      await assert.rejects(pending, /CDP Runtime.evaluate timed out after 750ms/);
    } else if (mode === 'cancelled') {
      await received;
      const reason = new Error('Recipe cancelled during HUD paint.');
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
      // A late reply cannot revive a cancelled call or close another caller's socket.
      for (const client of server.clients)
        client.send(JSON.stringify({ id: requestId, result: {} }));
      assert.equal(server.clients.size, 1);
    } else {
      assert.deepEqual(await pending, { hud: true });
      controller.abort(new Error('Cancellation after completion'));
    }
  });
}
