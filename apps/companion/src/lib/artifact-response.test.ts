import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  createGatewayResourceCache,
  readStoredArtifactResponse,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../packages/protocol/src/client-cache/conformance';

mock.module('../store/connection', {
  namedExports: { useConnectionStore: { getState: () => ({ status: 'connected' }) } },
});
mock.module('./gateway-http-auth', {
  namedExports: {
    gatewayFetch: async () => {
      throw new Error('No live HTTP in this test');
    },
  },
});
mock.module('./resource-cache', {
  namedExports: { getResourceCache: () => undefined, reportArtifactRefreshError: () => undefined },
});
const artifactResponse = import('./artifact-response');

test('closing a held document prevents the completed reread from reopening it', async () => {
  const { closeArtifactDocument } = await artifactResponse;
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://localhost:1234',
    principalId: 'owner',
    principalGeneration: 0,
  });
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const url = 'http://localhost:1234/api/run-artifact?runId=run&path=report.md';
  const controller = new AbortController();
  const pending: { current: AbortController | null } = { current: controller };
  const signal = controller.signal;
  let visible: string | null = null;
  const apply = async (response: Response) => {
    visible = await response.text();
  };
  let complete: ((response: Response) => void) | undefined;
  try {
    await readStoredArtifactResponse({
      current: () => cache,
      url,
      online: true,
      read: async () => new Response('held'),
    });
    const loaded = readStoredArtifactResponse({
      current: () => cache,
      url,
      online: true,
      signal,
      onStored: apply,
      read: () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    }).then(apply);
    const stopped = assert.rejects(loaded, { name: 'AbortError' });
    const deadline = Date.now() + 1000;
    while (!complete) {
      assert(Date.now() < deadline);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(visible, 'held');
    closeArtifactDocument(pending, () => {
      visible = null;
    });
    assert.equal(signal.aborted, true);
    complete(new Response('fresh'));
    await stopped;
    assert.equal(visible, null);
    assert.equal(pending.current, null);
  } finally {
    await cache.dispose();
  }
});
