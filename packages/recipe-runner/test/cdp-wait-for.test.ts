import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { CdpSession, CdpWebPage } from '../src/runtime/cdp.js';

test('ui.wait_for reports its own timeout when the last poll outlives the budget', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  server.on('connection', (client) => {
    let evaluations = 0;
    client.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: number; method: string };
      assert.equal(request.method, 'Runtime.evaluate');
      evaluations += 1;
      // The first poll sees no match; the page then stalls past the deadline, so the
      // last poll's per-call timer (the leftover budget) is what expires.
      if (evaluations === 1)
        client.send(JSON.stringify({ id: request.id, result: { result: { value: false } } }));
    });
  });
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());

  await assert.rejects(new CdpWebPage(session).waitFor({ selector: '#header', timeoutMs: 200 }), {
    message: 'ui.wait_for timed out',
  });
});
