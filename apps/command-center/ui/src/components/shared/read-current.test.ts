import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
} from '@farmslot/protocol/client-cache';
import { ResourceCacheConformanceTransport } from '../../../../../../packages/protocol/src/client-cache/conformance.js';
import { readFresh } from './read-current.js';

test('Eval launch rejects a saved cap after a failed reread, and accepts a fresh snapshot', async () => {
  const scope = { gatewayUrl: 'ws://localhost:1234', principalId: 'owner', principalGeneration: 0 };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const query = resourceQuery<{ cap: number }>('eval.suite.cap.get', { capGroupId: 'suite' });
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  await store.putQuery({ id: query.id, data: { cap: 4 }, bytes: 9, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  try {
    const stale = readFresh(cache, query, () => true);
    const refused = assert.rejects(stale, /current read/);
    (await transport.nextRead()).reject(new Error('Connection lost'));
    await refused;
    assert.equal(cache.read(query).data?.cap, 4);
    const fresh = readFresh(cache, query, () => true);
    (await transport.nextRead()).resolve({ cap: 1 });
    assert.equal((await fresh).cap, 1);
    const changedOwner = readFresh(cache, query, () => false);
    const rejected = assert.rejects(changedOwner, /current read/);
    (await transport.nextRead()).resolve({ cap: 2 });
    await rejected;
  } finally {
    await cache.dispose();
  }
});
