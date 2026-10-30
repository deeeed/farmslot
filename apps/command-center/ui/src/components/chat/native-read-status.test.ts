import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeReadStatus } from './native-read-status.js';

const current: Parameters<typeof nativeReadStatus>[0] = {
  connected: true,
  selected: true,
  caughtUp: true,
  taskHistory: false,
  sessionState: 'idle',
  observedAt: 90_000,
  now: 100_000,
};

test('a healthy revision change refreshes history without becoming an outage', () => {
  assert.deepEqual(nativeReadStatus(current), {
    state: 'ready',
    text: 'Live · idle',
    age: 'Updated 10s ago',
    retry: false,
  });
  const refreshing = nativeReadStatus({ ...current, caughtUp: false, refreshingHistory: true });
  assert.equal(refreshing.text, 'Refreshing history');
  assert.equal(refreshing.state, 'refreshing');
  assert.equal(refreshing.retry, false);
});

test('a real outage becomes unavailable only after 60 seconds, keeping the actual saved age', () => {
  const failed = {
    ...current,
    readError: 'Native observation source unavailable. Retry after source recovery.',
    unavailableSince: 100_000,
    saved: true,
  };
  const before = nativeReadStatus({ ...failed, now: 159_999 });
  assert.equal(before.state, 'reconnecting');
  assert.equal(before.age, 'Saved conversation history, 1m old. Actions wait for a current read.');
  const after = nativeReadStatus({ ...failed, now: 160_000 });
  assert.equal(after.state, 'unavailable');
  assert.equal(after.retry, true);
  assert.doesNotMatch(after.text, /observation source|source recovery/);
  assert.equal(nativeReadStatus({ ...failed, connected: false, now: 160_000 }).retry, false);
});

test('live observation ages use bounded minutes and hours', () => {
  assert.equal(nativeReadStatus({ ...current, now: 3_690_000 }).age, 'Updated 1h ago');
});

test('a pending retry keeps the outage status until the caller observes recovery', () => {
  assert.equal(
    nativeReadStatus({ ...current, unavailableSince: 100_000, now: 160_000 }).state,
    'unavailable',
  );
  assert.equal(nativeReadStatus({ ...current, observedAt: 160_000, now: 160_000 }).state, 'ready');
  assert.equal(nativeReadStatus({ ...current, unsupported: true }).state, 'unsupported');
  assert.equal(nativeReadStatus({ ...current, observedAt: undefined }).age, 'No history read yet');
});

test('a running turn shows how long it has worked and its current tool', () => {
  const work = { since: 28_000, tool: 'Bash' };
  assert.equal(
    nativeReadStatus({ ...current, sessionState: 'running', work }).text,
    'Working · 1m 12s · Bash',
  );
  assert.equal(
    nativeReadStatus({ ...current, sessionState: 'running', work: { since: 95_000 } }).text,
    'Working · 5s',
  );
  // A turn the session no longer runs (closed, failed, or waiting on the reader) keeps the state word.
  assert.equal(
    nativeReadStatus({ ...current, sessionState: 'waiting', work }).text,
    'Live · waiting',
  );
  assert.equal(nativeReadStatus({ ...current, sessionState: 'running' }).text, 'Live · running');
});
