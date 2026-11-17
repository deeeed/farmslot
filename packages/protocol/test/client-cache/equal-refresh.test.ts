import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import { createGatewayResourceCache, resourceQuery } from '../../src/client-cache/index.js';
import type { FleetStatusResult } from '../../src/rpc/fleet.js';
import { EntityGateway, flush, slot } from '../fixtures/entity-gateway.js';

const scope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'equal-reader',
  principalGeneration: 0,
};
const query = resourceQuery<{ value: string }>('sources.status');

test('checking a current value keeps it ready and an equal reply keeps its data identity', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    const initial = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'held' });
    const first = await initial;
    assert.equal(first.status, 'ready');
    const next = cache.retry(query);
    const read = await transport.nextRead();
    const whileReading = cache.read(query);
    read.resolve({ value: 'held' });
    const after = await next;
    assert.equal(
      whileReading.status,
      'ready',
      'Starting a check does not invalidate verified facts',
    );
    assert.equal(after.data, first.data, 'Equal bytes must not replace immutable view data');
    assert.notEqual(after, first, 'Read completion metadata remains an immutable new snapshot');
    const changed = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'changed' });
    assert.notEqual((await changed).data, first.data);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('equal fleet entity refreshes and repeated pushes keep displayed facts by identity', async () => {
  const transport = new EntityGateway();
  transport.slots.set('a', slot('a'));
  const cache = createGatewayResourceCache({ transport });
  const query = resourceQuery<FleetStatusResult>('fleet.status');
  const stop = cache.observe(query, () => {});
  try {
    await flush();
    const first = cache.read(query);
    assert.equal(first.status, 'ready');
    await cache.retry(query);
    assert.equal(cache.read(query).data, first.data, 'Equal entity refresh keeps the view');
    transport.writeSlot(slot('a'));
    await flush();
    assert.equal(cache.read(query).data, first.data, 'An equal push keeps the held view');
    transport.writeSlot(slot('a', { branch: 'changed' }));
    await flush();
    assert.notEqual(cache.read(query).data, first.data);
    assert.equal(cache.read(query).data?.fleet.slots[0]?.branch, 'changed');
  } finally {
    stop();
    await cache.dispose();
  }
});
