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

test('an observer that keeps throwing is reported once, naming its query', async (t) => {
  const reported = t.mock.method(console, 'error', () => {});
  const { transport, cache } = fixture();
  const stop = cache.observe(query, () => {
    throw new Error('observer failed');
  });
  try {
    transport.setConnection({ connected: true, id: 1 });
    (await transport.nextRead()).resolve({ value: 'current' });
    await settle();
    assert.equal(cache.read(query).status, 'ready');
    assert.equal(reported.mock.callCount(), 1);
    assert.match(String(reported.mock.calls[0]!.arguments[0]), /sources\.status/);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a failed read that holds no rows reads again on its own, backing off', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  const { transport, cache } = fixture();
  const stop = cache.observe(query, () => {});
  try {
    transport.setConnection({ connected: true, id: 1 });
    (await transport.nextRead()).reject('RESOURCE_OBSERVATION_UNAVAILABLE');
    await settle();
    assert.equal(cache.read(query).status, 'error');
    assert.equal(transport.requestCount, 1);

    t.mock.timers.tick(999);
    await settle();
    assert.equal(transport.requestCount, 1, 'it waits a second before asking again');
    t.mock.timers.tick(1);
    await settle();
    assert.equal(transport.requestCount, 2);
    (await transport.nextRead()).reject('RESOURCE_OBSERVATION_UNAVAILABLE');
    await settle();

    t.mock.timers.tick(1999);
    await settle();
    assert.equal(transport.requestCount, 2, 'the next wait doubles');
    t.mock.timers.tick(1);
    await settle();
    assert.equal(transport.requestCount, 3);
    (await transport.nextRead()).reject('RESOURCE_OBSERVATION_UNAVAILABLE');
    await settle();

    // A reconnect reads at once instead of waiting out the backoff.
    transport.setConnection({ connected: false, id: 1 }, 'network');
    transport.setConnection({ connected: true, id: 2 });
    await settle();
    assert.equal(transport.requestCount, 4);
    (await transport.nextRead()).resolve({ value: 'current' });
    await settle();
    assert.equal(cache.read(query).status, 'ready');
  } finally {
    stop();
    await cache.dispose();
  }
});
