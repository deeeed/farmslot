import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import { RecipeExecutionError } from '../src/core/failure.js';
import { CdpSession, CdpWebPage } from '../src/runtime/cdp.js';

// A page that answers its first `answers.length` polls with those values, then stalls
// past the deadline, so the last poll's per-call timer (the leftover budget) expires.
async function stallingPage(
  t: TestContext,
  answers: unknown[],
): Promise<{ page: CdpWebPage; evaluations: () => number }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let evaluations = 0;
  server.on('connection', (client) => {
    client.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: number; method: string };
      assert.equal(request.method, 'Runtime.evaluate');
      const answer = answers[evaluations];
      evaluations += 1;
      if (answer !== undefined)
        client.send(JSON.stringify({ id: request.id, result: { result: { value: answer } } }));
    });
  });
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());
  return { page: new CdpWebPage(session), evaluations: () => evaluations };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('the call resolved');
}

test('ui.wait_for reports its own timeout when the last poll outlives the budget', async (t) => {
  const { page, evaluations } = await stallingPage(t, [false]);
  const error = await rejection(page.waitFor({ selector: '#header', timeoutMs: 1_000 }));
  assert.equal(error.message, 'ui.wait_for timed out');
  assert.match(
    String((error.cause as Error | undefined)?.message),
    /^CDP Runtime\.evaluate timed out after \d+ms\.$/u,
  );
  assert.equal(evaluations(), 2);
});

test('an enabled wait that stalls after an observation keeps the subject failure and last state', async (t) => {
  const { page, evaluations } = await stallingPage(t, [{ matched: false, enabled: false }]);
  const error = await rejection(
    page.waitFor({ selector: '#buy', expected: 'present', enabled: true, timeoutMs: 1_000 }),
  );
  assert.ok(error instanceof RecipeExecutionError);
  assert.equal(error.causeClass, 'subject');
  assert.equal(
    error.message,
    'ui.wait_for timed out: expected enabled=true, last observed enabled=false.',
  );
  assert.equal(evaluations(), 2);
});

test('a page that answers no poll is a transport diagnostic, not a subject failure', async (t) => {
  const { page, evaluations } = await stallingPage(t, []);
  const error = await rejection(
    page.waitFor({ selector: '#buy', expected: 'present', enabled: true, timeoutMs: 1_000 }),
  );
  assert.ok(!(error instanceof RecipeExecutionError));
  assert.equal(error.message, 'ui.wait_for timed out: the page answered no poll in 1000ms');
  assert.equal(evaluations(), 1);
});

test('a click whose hover stalls past the readiness budget reports click readiness, not CDP', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const methods: string[] = [];
  server.on('connection', (client) => {
    client.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id: number; method: string };
      methods.push(request.method);
      const reply = (result: unknown) => client.send(JSON.stringify({ id: request.id, result }));
      if (request.method === 'Page.getFrameTree') reply({ frameTree: { frame: { id: 'main' } } });
      else if (request.method === 'Page.createIsolatedWorld') reply({ executionContextId: 1 });
      // The target is found at once; the page then stalls on the hover move.
      else if (request.method === 'Runtime.evaluate')
        reply({ result: { value: { x: 10, y: 10, selector: '#buy', tagName: 'BUTTON' } } });
    });
  });
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());

  const error = await rejection(new CdpWebPage(session).click('#buy'));
  assert.equal(error.message, 'Click target readiness timed out: #buy');
  assert.match(
    String((error.cause as Error | undefined)?.message),
    /^CDP Input\.dispatchMouseEvent timed out after \d+ms\.$/u,
  );
  assert.deepEqual(methods.slice(-1), ['Input.dispatchMouseEvent']);
});
