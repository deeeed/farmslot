import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NodeLinkQueue } from './queue.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

test('bulk cannot consume reserved control capacity and full queues refuse without side effects', async () => {
  const queue = new NodeLinkQueue({ inFlight: 2, reservedControl: 1, queuedBytes: 10 });
  const bulk = gate();
  const first = queue.run('bulk', 1, Infinity, () => bulk.promise);
  let called = false;
  const pending = queue.run('bulk', 5, Infinity, async () => {
    called = true;
  });
  await assert.rejects(
    queue.run('bulk', 1, Infinity, async () => assert.fail('Full queue ran')),
    { code: 'BACKPRESSURE' },
  );
  assert.equal(
    await queue.run('control', 1, Infinity, async () => 'cancel responsive'),
    'cancel responsive',
  );
  // Bulk leaves both byte credit and an execution slot for control.
  assert.equal(queue.activeCount, 1);
  assert.equal(called, false);
  queue.retire();
  await assert.rejects(pending, { code: 'STALE_SOCKET' });
  bulk.release();
  await first;
});

test('interactive work runs beside bulk and queued expiry never calls an executor', async () => {
  let now = 100;
  const queue = new NodeLinkQueue({ inFlight: 2, reservedControl: 1, queuedBytes: 100 }, () => now);
  const blocked = gate();
  const bulk = queue.run('bulk', 10, 200, () => blocked.promise);
  const expired = queue.run('bulk', 10, 110, async () => assert.fail('Expired work started'));
  assert.equal(await queue.run('interactive', 10, 200, async () => 'responsive'), 'responsive');
  now = 120;
  blocked.release();
  await bulk;
  await assert.rejects(expired, { code: 'COMMAND_EXPIRED' });
  assert.equal(queue.activeCount, 0);
});
