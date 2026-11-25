import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import { RecipeExecutionError } from '../src/core/failure.js';
import { CdpSession, CdpWebPage } from '../src/runtime/cdp.js';

// A fake page over a real CdpSession: `reply` returns a CDP result for a request, or
// undefined to stall it past the caller's deadline.
async function fakePage(
  t: TestContext,
  reply: (method: string) => unknown,
): Promise<{ page: CdpWebPage; methods: string[] }> {
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
      const result = reply(request.method);
      if (result !== undefined) client.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => session.close());
  return { page: new CdpWebPage(session), methods };
}

// Answers its first polls with `answers`, then stalls, so the last poll's per-call
// timer (the leftover budget) expires.
function stallingPage(t: TestContext, answers: unknown[]) {
  let polls = 0;
  return fakePage(t, (method) => {
    assert.equal(method, 'Runtime.evaluate');
    const answer = answers[polls++];
    return answer === undefined ? undefined : { result: { value: answer } };
  });
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

function assertCdpTimeoutCause(error: Error, method: string): void {
  assert.match(
    String((error.cause as Error | undefined)?.message),
    new RegExp(`^CDP ${method.replace('.', '\\.')} timed out after \\d+ms\\.$`, 'u'),
  );
}

test('ui.wait_for reports its own timeout when the last poll outlives the budget', async (t) => {
  const { page, methods } = await stallingPage(t, [false]);
  const error = await rejection(page.waitFor({ selector: '#header', timeoutMs: 500 }));
  assert.equal(error.message, 'ui.wait_for timed out');
  assertCdpTimeoutCause(error, 'Runtime.evaluate');
  assert.equal(methods.length, 2);
});

test('an enabled wait that stalls after an observation keeps the subject failure and last state', async (t) => {
  const { page, methods } = await stallingPage(t, [{ matched: false, enabled: false }]);
  const error = await rejection(
    page.waitFor({ selector: '#buy', expected: 'present', enabled: true, timeoutMs: 500 }),
  );
  assert.ok(error instanceof RecipeExecutionError);
  assert.equal(error.causeClass, 'subject');
  assert.equal(
    error.message,
    'ui.wait_for timed out: expected enabled=true, last observed enabled=false.',
  );
  assertCdpTimeoutCause(error, 'Runtime.evaluate');
  assert.equal(methods.length, 2);
});

test('a page that answers no poll is a transport diagnostic, not a subject failure', async (t) => {
  const { page, methods } = await stallingPage(t, []);
  const error = await rejection(
    page.waitFor({ selector: '#buy', expected: 'present', enabled: true, timeoutMs: 200 }),
  );
  assert.ok(!(error instanceof RecipeExecutionError));
  assert.equal(error.message, 'ui.wait_for timed out: the page answered no poll in 200ms');
  assertCdpTimeoutCause(error, 'Runtime.evaluate');
  assert.equal(methods.length, 1);
});

test('a click whose hover stalls past the readiness budget reports click readiness, not CDP', async (t) => {
  // The target is found at once; the page then stalls on the hover move.
  const { page, methods } = await fakePage(t, (method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate')
      return { result: { value: { x: 10, y: 10, selector: '#buy', tagName: 'BUTTON' } } };
    return undefined;
  });
  const error = await rejection(page.click('#buy'));
  assert.equal(error.message, 'Click target readiness timed out: #buy');
  assertCdpTimeoutCause(error, 'Input.dispatchMouseEvent');
  assert.deepEqual(methods.slice(-1), ['Input.dispatchMouseEvent']);
});
