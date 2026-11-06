import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NativeWorkerSessionBinding } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { publishNativeSessionChange } from '../resources/native-session-changes.js';
import { emitWorkerSignal } from '../tasks/watcher.js';

import { watchNativeReviewCompletion } from './native-review-wake.js';

const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  executionNodeId: 'node',
  ownerPrincipalId: 'owner',
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'command',
};
const input = { runId: 'run', slotId: 'slot', contextId: 'reviewer', binding };
const signal = {
  status: 'complete' as const,
  outcome: 'success' as const,
  timestamp: new Date(0).toISOString(),
};

for (const source of ['native', 'signal'] as const) {
  test(`${source} completion wakes an armed wait once eligible`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const watch = watchNativeReviewCompletion(input);
    t.after(() => watch.stop());
    watch.beforeRead();
    let settled = false;
    const waiting = watch.wait(500).then(() => {
      settled = true;
    });
    publishNativeSessionChange('other-node', 'owner');
    publishNativeSessionChange('node', 'other-owner');
    emitWorkerSignal('other-slot', 'run', signal, 'review', 'reviewer');
    emitWorkerSignal('slot', 'other-run', signal, 'review', 'reviewer');
    emitWorkerSignal('slot', 'run', signal, 'dev', 'reviewer');
    emitWorkerSignal('slot', 'run', signal, 'review', 'other-reviewer');
    await Promise.resolve();
    assert.equal(settled, false);
    if (source === 'native') {
      t.mock.timers.tick(100);
      publishNativeSessionChange('node', 'owner');
    } else emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
    await waiting;
    const wokeAt = source === 'native' ? 100 : 0;
    assert.equal(Date.now(), wokeAt);
    // The old fallback timer was cleared rather than left to wake a later read.
    watch.beforeRead();
    settled = false;
    const next = watch.wait(500).then(() => {
      settled = true;
    });
    t.mock.timers.tick(499);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await next;
    assert.equal(Date.now(), wokeAt + 500);
  });
}

test('neighbouring native changes limit reads to 10 per second while the exact signal wakes immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const watch = watchNativeReviewCompletion(input);
  let active = true;
  t.after(() => {
    active = false;
    watch.stop();
  });
  const reads: number[] = [];
  const reviewing = (async () => {
    while (active) {
      reads.push(Date.now());
      watch.beforeRead();
      await watch.wait(500);
    }
  })();
  for (let elapsed = 5; elapsed < 1000; elapsed += 5) {
    t.mock.timers.tick(5);
    publishNativeSessionChange('node', 'owner');
    await Promise.resolve();
  }
  t.diagnostic(`${reads.length} validated reads over 995ms of native changes`);
  assert.deepEqual(
    reads,
    Array.from({ length: 10 }, (_, index) => index * 100),
  );
  // A native wake is pending until 1000ms, but the exact completion must bypass it.
  emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
  await Promise.resolve();
  assert.equal(reads.at(-1), 995);
  assert.equal(reads.length, 11);
  active = false;
  watch.stop();
  await reviewing;
});

test('native changes during a read collapse into one wake measured from the read start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const watch = watchNativeReviewCompletion(input);
  t.after(() => watch.stop());
  watch.beforeRead();
  t.mock.timers.tick(20);
  publishNativeSessionChange('node', 'owner');
  t.mock.timers.tick(20);
  publishNativeSessionChange('node', 'owner');
  let settled = false;
  const waiting = watch.wait(500).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(59);
  publishNativeSessionChange('node', 'owner');
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(Date.now(), 100);
  watch.beforeRead();
  t.mock.timers.tick(20);
  emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
  await watch.wait(500);
  assert.equal(Date.now(), 120);
});

test('stopping completion observation releases its pending wait and detaches listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const watch = watchNativeReviewCompletion(input);
  t.after(() => watch.stop());
  watch.beforeRead();
  const waiting = watch.wait(500);
  publishNativeSessionChange('node', 'owner');
  watch.stop();
  await waiting;
  publishNativeSessionChange('node', 'owner');
  emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
  t.mock.timers.tick(500);
  await watch.wait(500);
});

test('a native wake preserves a fallback shorter than the read floor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const watch = watchNativeReviewCompletion(input);
  t.after(() => watch.stop());
  watch.beforeRead();
  const waiting = watch.wait(50);
  t.mock.timers.tick(20);
  publishNativeSessionChange('node', 'owner');
  t.mock.timers.tick(30);
  await waiting;
  assert.equal(Date.now(), 50);
});
