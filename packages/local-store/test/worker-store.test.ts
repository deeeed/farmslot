import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  createGatewayResourceCache,
  resourceQuery,
  resourceStoreScopeId,
  runResourceStoreConformance,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../protocol/src/client-cache/conformance.js';
import { ResourceStoreWorkerClient } from '../src/worker-client.js';
import type { StoreWorkerPort } from '../src/worker-protocol.js';

function fixture() {
  const worker = new Worker(new URL('./sqlite-worker.fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
  });
  const port: StoreWorkerPort = {
    postMessage: (request) => worker.postMessage(request),
    onMessage(listener) {
      worker.on('message', listener);
      return () => {
        worker.off('message', listener);
      };
    },
    onError(listener) {
      worker.on('error', listener);
      return () => {
        worker.off('error', listener);
      };
    },
    terminate() {
      void worker.terminate();
    },
  };
  const client = new ResourceStoreWorkerClient(port);
  return { client, worker };
}

test('the browser worker adapter runs portable conformance against real SQLite WebAssembly', async () => {
  const { client, worker } = fixture();
  try {
    const passed = await runResourceStoreConformance((scope) => client.open(scope));
    assert.equal(passed.length, 22);
    const diagnostics = await client.diagnostics();
    assert.equal(diagnostics.storage, 'memory-test');
    assert.equal(diagnostics.integrity, 'ok');
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('a different tab deleting a scope seals existing proxies and removes its SQL rows', async () => {
  const { client, worker } = fixture();
  const scope = { gatewayUrl: 'ws://sqlite.invalid/', principalId: 'p', principalGeneration: 0 };
  try {
    const old = await client.open(scope);
    await old.putQuery({ id: 'q', data: { value: 'before deletion' }, observedAt: 1, bytes: 20 });
    await client.deleteScope(resourceStoreScopeId(scope));
    assert(old.deleted);
    await old.putQuery({ id: 'q', data: { value: 'late' }, observedAt: 2, bytes: 5 });
    const fresh = await client.open(scope);
    assert.equal(await fresh.getQuery('q'), undefined);
    await old.close();
    await fresh.close();
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('content blobs cross the worker boundary intact and leave with their scope', async () => {
  const { client, worker } = fixture();
  const scope = { gatewayUrl: 'ws://content.invalid/', principalId: 'p', principalGeneration: 0 };
  try {
    const store = await client.open(scope);
    const data = new Uint8Array(1024 * 1024).map((_, index) => (index * 7) % 256);
    const key = { kind: 'blob' as const, id: 'binary' };
    await store.putContent({
      ...key,
      data,
      bytes: data.byteLength,
      origin: 'prefetch',
      cohort: 'run',
      accessedAt: 1,
    });
    await store.touchContent(key, 2, 'opened');
    await store.putContentAlias('frozen-diff:run:base:head', key);
    assert.equal(await store.hasContent(key), true);
    assert.deepEqual((await store.getContentByAlias('frozen-diff:run:base:head'))?.data, data);
    const saved = await store.getContent(key);
    assert.deepEqual(saved?.data, data);
    assert.equal(saved?.origin, 'opened');
    assert.equal(saved?.accessedAt, 2);
    assert.equal((await store.byteTotals()).content, data.byteLength);
    await client.deleteScope(resourceStoreScopeId(scope));
    const fresh = await client.open(scope);
    assert.deepEqual(await fresh.listContent(), []);
    assert.equal(await fresh.getContentByAlias('frozen-diff:run:base:head'), undefined);
    await store.close();
    await fresh.close();
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('intentional worker teardown lets its retired proxies close without another port request', async () => {
  const { client, worker } = fixture();
  const scope = { gatewayUrl: 'ws://teardown.invalid/', principalId: 'p', principalGeneration: 0 };
  try {
    const store = await client.open(scope);
    client.close();
    await store.close();
    await store.close();
    client.close();
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('cache retention evictions persist through the asynchronous SQLite worker and reopen', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { client, worker } = fixture();
  const scope = { gatewayUrl: 'ws://retention.invalid/', principalId: 'p', principalGeneration: 0 };
  const store = await client.open(scope);
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  const query = (runId: string) => ({
    ...resourceQuery<{ value: string }>('sources.status', { runId }),
    retention: { maxEntries: 2, maxBytes: 256 },
  });
  try {
    for (let index = 0; index < 3; index++) {
      t.mock.timers.tick(1);
      const pending = cache.retry(query(String(index)));
      (await transport.nextRead()).resolve({ value: `run ${index}` });
      assert.equal((await pending).status, 'ready');
    }
    assert.equal((await store.listQueries()).length, 2);
    assert.equal(await store.getQuery(query('0').id), undefined);
    assert.equal(cache.read(query('0')).data?.value, 'run 0');
    const oversized = cache.retry(query('1'));
    (await transport.nextRead()).resolve({ value: 'x'.repeat(257) });
    assert.equal((await oversized).status, 'ready');
    assert.equal(cache.read(query('1')).data?.value.length, 257);
    assert.equal(await store.getQuery(query('1').id), undefined);
    await cache.dispose();
    const reopened = await client.open(scope);
    try {
      assert.deepEqual(
        (await reopened.listQueries()).map(({ id }) => id),
        [query('2').id],
      );
      assert.equal(
        (await reopened.getQuery<{ value: string }>(query('2').id))?.data.value,
        'run 2',
      );
      assert.equal((await client.diagnostics()).integrity, 'ok');
    } finally {
      await reopened.close();
    }
  } finally {
    await cache.dispose();
    client.close();
    await worker.terminate();
  }
});
