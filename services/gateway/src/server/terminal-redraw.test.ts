import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalRedraws, REDRAW_FALLBACK_MS, REDRAW_PENDING_MS } from './terminal-redraw.js';

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 1_000_000 });
  const redrawn: string[] = [];
  const redraws = createTerminalRedraws<object>((key) => redrawn.push(key));
  return { redraws, redrawn, client: {}, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('a viewer that leaves before its redraw cancels it', (t) => {
  const { redraws, redrawn, client, tick } = fixture(t);
  redraws.expect(client, 'pty');
  redraws.cancel(client, 'pty');
  assert.equal(redraws.pendingCount(client), 0);
  tick(REDRAW_PENDING_MS);
  assert.deepEqual(redrawn, []);
});

test('a resize before the fallback redraws once, after its response', (t) => {
  const { redraws, redrawn, client, tick } = fixture(t);
  redraws.expect(client, 'pty');
  redraws.afterResize(client, 'pty');
  assert.deepEqual(redrawn, [], 'not before the resize response is sent');
  tick(0);
  assert.deepEqual(redrawn, ['pty']);
  tick(REDRAW_PENDING_MS);
  redraws.afterResize(client, 'pty');
  tick(0);
  assert.deepEqual(redrawn, ['pty'], 'the fallback and a later resize add nothing');
});

test('the fallback redraws; a late resize within the window redraws again; then it is dropped', (t) => {
  const { redraws, redrawn, client, tick } = fixture(t);
  redraws.expect(client, 'late');
  redraws.expect(client, 'never');
  tick(REDRAW_FALLBACK_MS);
  assert.deepEqual(redrawn, ['late', 'never']);
  redraws.afterResize(client, 'late');
  tick(0);
  assert.deepEqual(redrawn, ['late', 'never', 'late'], 'a client that sized late is repaired');
  assert.equal(redraws.pendingCount(client), 1, 'kept through its window for a late resize');
  tick(REDRAW_PENDING_MS);
  assert.equal(redraws.pendingCount(client), 0, 'dropped once its window ends');
  redraws.afterResize(client, 'never');
  tick(0);
  assert.deepEqual(redrawn, ['late', 'never', 'late'], 'the entry is gone once its window ends');
});
