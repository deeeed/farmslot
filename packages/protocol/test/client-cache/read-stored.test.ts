import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  readStoredResource,
  resourceQuery,
  type ResourceStoreScope,
} from '../../src/client-cache/index.js';

const scope: ResourceStoreScope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'a',
  principalGeneration: 0,
};

test('display reads return stored data offline without a transport request', async () => {
  const query = resourceQuery<{ value: string }>('sources.status');
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await store.putQuery({ id: query.id, data: { value: 'saved' }, bytes: 17, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = { roles: [], workspaceAccess: 'farm' };
  const cache = createGatewayResourceCache({ transport, store });
  try {
    assert.deepEqual(await readStoredResource(() => cache, query), { value: 'saved' });
    assert.equal(transport.requestCount, 0);
    assert.equal(cache.read(query).status, 'stale');
    await assert.rejects(
      readStoredResource(() => undefined, query),
      /store is not open/,
    );
  } finally {
    await cache.dispose();
  }
});

test('a display read cannot publish the retired owner reply', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  let current: typeof cache | undefined = cache;
  try {
    const result = readStoredResource(() => current, resourceQuery('sources.status'));
    const pending = await transport.nextRead();
    current = undefined;
    pending.resolve({ value: 'retired owner' });
    await assert.rejects(result, /owner changed/);
  } finally {
    await cache.dispose();
  }
});

test('a cold local display does not wait for a connected slow gateway', async () => {
  const query = resourceQuery<{ value: string }>('sources.status');
  const store = createMemoryResourceStore();
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  await store.setMetadata({ scope, authority });
  await store.putQuery({ id: query.id, data: { value: 'saved' }, bytes: 17, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  try {
    assert.deepEqual(await readStoredResource(() => cache, query), { value: 'saved' });
    const pending = await transport.nextRead();
    assert.equal(cache.read(query).data?.value, 'saved');
    pending.resolve({ value: 'fresh' });
    assert.equal((await cache.retry(query)).data?.value, 'fresh');
  } finally {
    await cache.dispose();
  }
});

test('one-shot displays paint the saved value and then receive the completed reread', async () => {
  const query = resourceQuery<{ value: string }>('sources.status');
  const store = createMemoryResourceStore();
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  await store.setMetadata({ scope, authority });
  await store.putQuery({ id: query.id, data: { value: '7' }, bytes: 13, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  let shown = '';
  const apply = (data: { value: string }) => {
    shown = data.value;
  };
  try {
    const result = readStoredResource(() => cache, query, apply).then(apply);
    const pending = await transport.nextRead();
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shown, '7');
    pending.resolve({ value: '8' });
    await result;
    assert.equal(shown, '8');
  } finally {
    await cache.dispose();
  }
});

test('display reads preserve typed missing-file and genuine refusal codes', async () => {
  const query = resourceQuery('fs.read', { slotId: 'slot', path: 'artifacts/result.json' });
  for (const code of ['FS_NOT_FOUND', 'AUTH_FORBIDDEN']) {
    const cache = {
      async retry() {
        return { status: 'error' as const, error: { code, message: 'Read unavailable' } };
      },
      async readStored() {
        return undefined;
      },
    };
    await assert.rejects(
      readStoredResource(() => cache, query),
      { code },
    );
  }
});

test(
  'source reads reuse held blobs and request missing paths without scanning other blobs',
  { timeout: 1000 },
  async () => {
    const { gitBlobHash, readGitSource } = await import('../../src/client-cache/index.js');
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection({
      connected: true,
      id: 1,
      capabilities: {
        ...transport.connection.capabilities!,
        resourceChanges: {
          version: 1,
          epoch: 'conformance-epoch',
          observedReads: 1,
          workspaceReads: 1,
        },
      },
    });
    const cache = createGatewayResourceCache({ transport });
    const data = new TextEncoder().encode('reviewed\n');
    const other = new TextEncoder().encode('other\n');
    const id = gitBlobHash(data);
    const otherId = gitBlobHash(other);
    const params = { slotId: 'example-slot', ref: 'a'.repeat(40), path: 'source.ts' };
    try {
      assert.equal(
        await cache.storeContent({
          key: { kind: 'blob', id: otherId },
          data: other,
          origin: 'opened',
          cohort: 'gate',
        }),
        true,
      );
      let calls = 0;
      const read = async (batch: unknown) => {
        calls++;
        assert.deepEqual(batch, {
          slotId: 'example-slot',
          ref: params.ref,
          paths: ['source.ts'],
          maxBytes: 10485760,
          maxFileBytes: 10485760,
        });
        return {
          entries: [
            {
              path: params.path,
              status: 'ok' as const,
              id,
              size: data.length,
              content: Buffer.from(data).toString('base64'),
            },
          ],
          cursor: params.path,
          hasMore: false,
        };
      };
      assert.deepEqual(await readGitSource(() => cache, params, read), {
        content: 'reviewed\n',
        id,
      });
      assert.deepEqual(await readGitSource(() => cache, params, read), {
        content: 'reviewed\n',
        id,
      });
      assert.equal(calls, 1);
      assert.deepEqual(
        await readGitSource(
          () => cache,
          { ...params, path: 'same-blob.ts' },
          () => assert.fail('held blob was requested'),
          id,
        ),
        { content: 'reviewed\n', id },
      );
      assert.equal(transport.requestCount, 0);
    } finally {
      await cache.dispose();
    }
  },
);

test('batched source queries retain the same workspace and frozen-run fences', () => {
  const params = {
    slotId: 'example',
    runId: 'run-one',
    ref: 'a'.repeat(40),
    paths: ['src/a.ts'],
    have: ['b'.repeat(40)],
  };
  const slot = resourceQuery('git.show', params);
  assert.deepEqual(slot.dependencies, [
    { family: 'workspace', slotId: 'example', runId: 'run-one' },
    { family: 'slot', slotId: 'example' },
    { family: 'run', runId: 'run-one' },
  ]);
  assert.equal(slot.requiresWorkspaceRead, true);
  const frozen = resourceQuery('git.show', { ...params, slotId: '' });
  assert.equal(frozen.requiresWorkspaceRead, undefined);
  assert.deepEqual(frozen.dependencies, []);
  assert.deepEqual(Reflect.get(frozen.params as object, 'paths'), ['src/a.ts']);
  assert.throws(() => resourceQuery('git.show', { ...params, path: 'src/a.ts' }), /path or paths/);
});
