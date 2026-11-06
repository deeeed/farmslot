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
  test(`${source} completion wakes an armed wait without advancing time`, async (t) => {
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
    if (source === 'native') publishNativeSessionChange('node', 'owner');
    else emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
    await waiting;
    assert.equal(Date.now(), 0);
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
    assert.equal(Date.now(), 500);
  });
}

test('stopping completion observation releases its pending wait and detaches listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const watch = watchNativeReviewCompletion(input);
  t.after(() => watch.stop());
  watch.beforeRead();
  const waiting = watch.wait(500);
  watch.stop();
  await waiting;
  publishNativeSessionChange('node', 'owner');
  emitWorkerSignal('slot', 'run', signal, 'review', 'reviewer');
  t.mock.timers.tick(500);
  await watch.wait(500);
});
