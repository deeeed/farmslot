import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvalSuiteCapGetResult } from '@farmslot/protocol';
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
  const query = resourceQuery<EvalSuiteCapGetResult>('eval.suite.cap.get', { capGroupId: 'suite' });
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  await store.putQuery({
    id: query.id,
    data: {
      capGroupId: 'suite',
      cap: 4,
      active: 0,
      dispatching: 0,
      queued: 0,
      total: 0,
    } satisfies EvalSuiteCapGetResult,
    bytes: 9,
    observedAt: 123,
  });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  try {
    const stale = readFresh(cache, query, () => true);
    const refused = assert.rejects(stale, /current read/);
    (await transport.nextRead()).reject('READ_FAILED');
    await refused;
    assert.equal(cache.read(query).data?.cap, 4);
    const fresh = readFresh(cache, query, () => true);
    (await transport.nextRead()).resolve({
      capGroupId: 'suite',
      cap: 1,
      active: 0,
      dispatching: 0,
      queued: 0,
      total: 0,
    } satisfies EvalSuiteCapGetResult);
    assert.equal((await fresh).cap, 1);
    const changedOwner = readFresh(cache, query, () => false);
    const rejected = assert.rejects(changedOwner, /current read/);
    (await transport.nextRead()).resolve({
      capGroupId: 'suite',
      cap: 2,
      active: 0,
      dispatching: 0,
      queued: 0,
      total: 0,
    } satisfies EvalSuiteCapGetResult);
    await rejected;
  } finally {
    await cache.dispose();
  }
});

async function copilotCache() {
  const scope = { gatewayUrl: 'ws://localhost:1234', principalId: 'owner', principalGeneration: 0 };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      ...transport.connection.capabilities!,
      resourceChanges: {
        version: 1,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1,
      },
    },
  });
  const cache = createGatewayResourceCache({ transport, store });
  return { cache, transport, query: resourceQuery<{ status: string }>('copilot.status', {}) };
}

test('An action preflight reads again when the gateway supersedes its read', async () => {
  const { cache, transport, query } = await copilotCache();
  try {
    const fresh = readFresh(cache, query, () => true, { rechecked: true });
    (await transport.nextRead()).reject('RESOURCE_OBSERVATION_CHANGED');
    (await transport.nextRead()).resolve({ status: 'running' });
    assert.equal((await fresh).status, 'running');
  } finally {
    await cache.dispose();
  }
});

test('A dependency change after the preflight read fails only actions the gateway does not recheck', async () => {
  const { cache, transport, query } = await copilotCache();
  try {
    const strict = assert.rejects(
      readFresh(cache, query, () => true),
      /current read/,
    );
    (await transport.nextRead()).resolve({ status: 'stopped' });
    await strict;
    const fresh = readFresh(cache, query, () => true, { rechecked: true });
    (await transport.nextRead()).resolve({ status: 'stopped' });
    // Live runs change slots and workers continuously; one lands right after the read.
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [{ key: { family: 'slots', scope: 'farm' }, revision: 9, kind: 'updated' }],
    });
    assert.equal((await fresh).status, 'stopped');
  } finally {
    await cache.dispose();
  }
});
