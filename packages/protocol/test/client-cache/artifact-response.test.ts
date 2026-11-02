import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  readStoredArtifactResponse,
} from '../../src/client-cache/index.js';

const scope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'operator',
  principalGeneration: 0,
};
const url = 'http://localhost:1234/api/run-artifact?runId=retained&path=artifacts%2Freport.html';

test('artifact text survives cache recreation and offline reads never fetch', async () => {
  const store = createMemoryResourceStore();
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  // Keep the in-memory backing store open while the first cache instance closes its handle.
  let cache = createGatewayResourceCache({
    transport,
    store: { ...store, close: async () => undefined },
  });
  const read = async () => new Response('<p>Retained report</p>');
  try {
    const response = await readStoredArtifactResponse({
      current: () => cache,
      url,
      online: true,
      read,
    });
    assert.equal(await response.text(), '<p>Retained report</p>');
    assert.equal((await store.listContent()).length, 1);
    await cache.dispose();
    transport.setConnection({ connected: false, id: 2 }, 'network');
    cache = createGatewayResourceCache({ transport, store });
    const held = await readStoredArtifactResponse({
      current: () => cache,
      url: url + '&token=not-persisted&m=1',
      online: false,
      read: async () => {
        throw new Error('An offline read must not fetch');
      },
    });
    assert.equal(await held.text(), '<p>Retained report</p>');
    assert.equal((await store.listContent()).length, 1);
  } finally {
    await cache.dispose();
  }
});

test('artifact responses cannot publish after the owner changes during the fetch', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  let current: typeof cache | undefined = cache;
  try {
    await assert.rejects(
      readStoredArtifactResponse({
        current: () => current,
        url,
        online: true,
        read: async () => {
          current = undefined;
          return new Response('Former owner');
        },
      }),
      /source changed/,
    );
    assert.equal(await cache.openContentByAlias('not-stored'), undefined);
  } finally {
    await cache.dispose();
  }
});

test('online artifact reads replace changed text and an authorization refusal removes the held copy', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  let body = 'first';
  const options = { current: () => cache, url, online: true, read: async () => new Response(body) };
  try {
    assert.equal(await (await readStoredArtifactResponse(options)).text(), 'first');
    body = 'updated';
    assert.equal(await (await readStoredArtifactResponse(options)).text(), 'updated');
    assert.equal(await (await readStoredArtifactResponse({ ...options, online: false })).text(), 'updated');
    const denied = await readStoredArtifactResponse({ ...options, read: async () => new Response('', { status: 403 }) });
    assert.equal(denied.status, 403);
    await assert.rejects(readStoredArtifactResponse({ ...options, online: false }), /not been stored/);
  } finally { await cache.dispose(); }
});
