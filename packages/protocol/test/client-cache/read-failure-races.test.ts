import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import { createGatewayResourceCache, resourceQuery } from '../../src/client-cache/index.js';

const query = resourceQuery<{ value: string }>('sources.status');
async function fixture() {
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://read-failure.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  });
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  const warm = cache.retry(query);
  (await transport.nextRead()).resolve({ value: 'before writes' });
  await warm;
  return { transport, cache, stop };
}

for (const code of ['RESOURCE_OBSERVATION_UNAVAILABLE', 'NATIVE_SOURCE_UNAVAILABLE']) {
  test(`a write during failed ${code} I/O retains exactly one follow-up`, async () => {
    const { transport, cache, stop } = await fixture();
    try {
      transport.advance(1);
      const failed = cache.retry(query);
      const held = await transport.nextRead();
      transport.advance(2);
      held.reject(code);
      await failed;
      // No explicit Retry after rejection: the second write still needs its read.
      const followup = await transport.nextRead();
      assert.equal(transport.requestCount, 3);
      followup.resolve({ value: 'after both writes' }, 2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(cache.read(query).status, 'ready');
      assert.equal(cache.read(query).data?.value, 'after both writes');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(transport.requestCount, 3);
    } finally {
      stop();
      await cache.dispose();
    }
  });
}

test('a failed read without an intervening write stays visible without an automatic retry', async () => {
  const { transport, cache, stop } = await fixture();
  try {
    transport.advance(1);
    const failed = cache.retry(query);
    const held = await transport.nextRead();
    held.reject('RESOURCE_OBSERVATION_UNAVAILABLE');
    await failed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transport.requestCount, 2);
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).error?.code, 'RESOURCE_OBSERVATION_UNAVAILABLE');
    assert.equal(cache.read(query).data?.value, 'before writes');
  } finally {
    stop();
    await cache.dispose();
  }
});

for (const code of ['AUTH_FORBIDDEN', 'NOT_FOUND', 'RESOURCE_OBSERVATION_UNSUPPORTED']) {
  test(`${code} does not retry even when a write raced the refused read`, async () => {
    const { transport, cache, stop } = await fixture();
    try {
      transport.advance(1);
      const failed = cache.retry(query);
      const held = await transport.nextRead();
      transport.advance(2);
      held.reject(code);
      await failed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(transport.requestCount, 2);
      assert.equal(cache.read(query).error?.code, code);
      if (code !== 'RESOURCE_OBSERVATION_UNSUPPORTED')
        assert.equal(cache.read(query).data, undefined);
    } finally {
      stop();
      await cache.dispose();
    }
  });
}
