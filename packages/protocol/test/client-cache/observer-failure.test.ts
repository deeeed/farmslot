import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  resourceQuery,
  type ResourceQueryStatus,
} from '../../src/client-cache/index.js';

const query = resourceQuery<{ value: string }>('sources.status');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://observer-failure.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  });
  return { transport, cache: createGatewayResourceCache({ transport }) };
}

test('an observer that throws when a read starts cannot leave the query loading', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { transport, cache } = fixture();
  let fail = false;
  const failing = cache.observe(query, (state) => {
    if (!fail || state.status !== 'loading') return;
    fail = false;
    throw new Error('observer failed');
  });
  const heard: ResourceQueryStatus[] = [];
  const other = cache.observe(query, (state) => heard.push(state.status));
  try {
    fail = true;
    transport.setConnection({ connected: true, id: 1 });
    (await transport.nextRead()).resolve({ value: 'current' });
    await settle();
    assert.equal(cache.read(query).status, 'ready');
    assert.equal(cache.read(query).data?.value, 'current');
    assert.deepEqual(heard.slice(-2), ['loading', 'ready'], 'the other observer heard both');
  } finally {
    failing();
    other();
    await cache.dispose();
  }
});

test('each failing observer is reported once, naming its query', async (t) => {
  const reported = t.mock.method(console, 'error', () => {});
  const { transport, cache } = fixture();
  // Throws on its first delivery too, which used to skip the read `observe` schedules.
  const first = cache.observe(query, () => {
    throw new Error('first observer failed');
  });
  try {
    transport.setConnection({ connected: true, id: 1 });
    (await transport.nextRead()).resolve({ value: 'current' });
    await settle();
    assert.equal(cache.read(query).status, 'ready');
    assert.equal(reported.mock.callCount(), 1, 'a repeating failure is logged once');
    assert.match(String(reported.mock.calls[0]!.arguments[0]), /sources\.status/);

    const second = cache.observe(query, () => {
      throw new Error('second observer failed');
    });
    second();
    assert.equal(reported.mock.callCount(), 2, 'another observer of the same query is logged too');
    assert.match(String(reported.mock.calls[1]!.arguments[1]), /second observer failed/);
  } finally {
    first();
    await cache.dispose();
  }
});
