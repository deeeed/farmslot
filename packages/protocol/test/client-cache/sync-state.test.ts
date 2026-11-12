import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import { createGatewayResourceCache, resourceQuery } from '../../src/client-cache/index.js';
import { resourceSyncLabel, resourceSyncState } from '../../src/client-cache/sync-state.js';

test('connection alone cannot mark held or loading views synced', () => {
  const held = { status: 'stale', data: {}, observedAt: 1000 } as const;
  assert.deepEqual(resourceSyncState([held], true), { status: 'syncing' });
  assert.deepEqual(resourceSyncState([held], false), { status: 'cached', observedAt: 1000 });
  assert.deepEqual(resourceSyncState([{ ...held, status: 'ready' }], true), { status: 'synced' });
  assert.deepEqual(resourceSyncState([{ ...held, status: 'ready' }], false), {
    status: 'cached',
    observedAt: 1000,
  });
  assert.deepEqual(resourceSyncState([{ ...held, status: 'ready' }, { status: 'loading' }], true), {
    status: 'syncing',
  });
});

test('failed reads retain their oldest source timestamp, including unknown ages', () => {
  const failed = {
    status: 'stale',
    data: {},
    observedAt: 9000,
    error: { code: 'IO', message: 'Unavailable' },
  } as const;
  assert.deepEqual(
    resourceSyncState(
      [failed, { ...failed, sourceObservation: { status: 'stale', observedAt: 1000 } }],
      true,
    ),
    { status: 'cached', observedAt: 1000 },
  );
  assert.deepEqual(resourceSyncState([{ ...failed, observedAt: undefined }], true), {
    status: 'cached',
    observedAt: undefined,
  });
  assert.equal(resourceSyncLabel({ status: 'synced' }), 'Synced');
  assert.match(resourceSyncLabel({ status: 'cached', observedAt: 1000 }), /^Cached from /);
});

test('observed views publish syncing, synced and cached across a real cache reconnect', async () => {
  const transport = new ResourceCacheConformanceTransport({ gatewayUrl: 'ws://sync.invalid/' });
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const query = resourceQuery<{ value: string }>('sources.status');
  const statuses: string[] = [];
  const stopSync = cache.observeSync!(
    (state) => statuses.push(state.status),
    (candidate) => candidate.id === query.id,
  );
  let stopOther = () => {};
  const stop = cache.observe(query, () => {});
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'before' });
    await first;
    assert.equal(statuses.at(-1), 'synced');
    const other = resourceQuery('run.list', { active: true });
    stopOther = cache.observe(other, () => {});
    const failing = cache.retry(other);
    (await transport.nextRead()).reject('UNAVAILABLE');
    await failing;
    assert.equal(statuses.at(-1), 'synced', 'An unrelated read cannot change this view status');
    stopOther();
    transport.setConnection({ connected: false }, 'network');
    assert.equal(statuses.at(-1), 'cached');
    transport.setConnection({ connected: true, id: 2 });
    const next = cache.retry(query);
    const read = await transport.nextRead();
    assert.equal(statuses.at(-1), 'syncing');
    read.resolve({ value: 'after' });
    await next;
    assert.equal(statuses.at(-1), 'synced');
  } finally {
    stop();
    stopOther();
    stopSync();
    await cache.dispose();
  }
});

test('an entity catch-up reports determinate progress while connected', () => {
  const partial = {
    status: 'stale',
    data: {},
    observedAt: 1000,
    catchUpProgress: { done: 20, total: 25 },
  } as const;
  assert.deepEqual(resourceSyncState([partial], true), { status: 'catch-up', done: 20, total: 25 });
  assert.equal(resourceSyncLabel({ status: 'catch-up', done: 20, total: 25 }), 'Syncing 20 of 25');
  assert.deepEqual(resourceSyncState([partial], false), { status: 'cached', observedAt: 1000 });
  assert.deepEqual(
    resourceSyncState([{ ...partial, catchUpProgress: { done: 25, total: 25 } }], true),
    { status: 'syncing' },
  );
});
