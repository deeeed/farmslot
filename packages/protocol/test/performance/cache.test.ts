import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceStore,
} from '../../src/client-cache/index.js';
import { PerformanceRecorder } from '../../src/performance/index.js';

test(
  'foreground paint includes store hydration and never waits for the held background reread',
  { timeout: 3000 },
  async () => {
    const scope = {
      gatewayUrl: 'ws://performance.invalid/',
      principalId: 'p',
      principalGeneration: 0,
    };
    const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
    const authority = { roles: [], workspaceAccess: 'farm' as const };
    const memory = createMemoryResourceStore();
    await memory.setMetadata({ scope, authority });
    await memory.putQuery({
      id: query.id,
      data: { value: 'cached' },
      observedAt: Date.now() - 1000,
      bytes: 18,
    });
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const store: ResourceStore = {
      ...memory,
      get deleted() {
        return memory.deleted;
      },
      async getQuery<T>(id: string) {
        const row = await memory.getQuery<T>(id);
        started();
        await held;
        return row;
      },
    };
    let clock = 0;
    const metrics = new PerformanceRecorder('command-center', { clock: () => clock });
    const frames: Array<() => void> = [];
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.connection.authority = authority;
    const cache = createGatewayResourceCache({
      transport,
      store,
      performance: metrics,
      afterPaint: (callback) => {
        frames.push(callback);
        return () => {};
      },
    });
    const stop = cache.observe(query, () => {});
    try {
      await reached;
      clock = 0.2;
      release();
      assert.equal((await cache.readStored!(query, false)).data?.value, 'cached');
      clock = 0.25;
      frames.shift()?.();
      assert.equal(
        metrics
          .snapshot()
          .histograms.find((row) => row.name === 'farmslot_client_cached_paint_seconds')?.max,
        0.25,
      );
      transport.setConnection({ connected: true, id: 2 });
      const pending = cache.retry(query);
      const read = await transport.nextRead();
      assert.equal(cache.read(query).data?.value, 'cached');
      clock = 0.5;
      read.resolve({ value: 'fresh' });
      await pending;
      assert(
        metrics
          .snapshot()
          .histograms.some((row) => row.name === 'farmslot_client_background_refresh_seconds'),
      );
      assert.equal(
        metrics
          .snapshot()
          .histograms.find((row) => row.name === 'farmslot_client_cached_paint_seconds')?.count,
        1,
      );
    } finally {
      release();
      stop();
      await cache.dispose();
    }
  },
);
