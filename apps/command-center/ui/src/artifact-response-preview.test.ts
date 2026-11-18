import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';

let cache: GatewayResourceCache | undefined;
let response: Response;
let fetches = 0;
mock.module('./resource-cache.js', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceWorkspaceKey: () => 'preview-owner',
  },
});
mock.module('./gateway-client.js', { namedExports: { gateway: { connectionState: 'connected' } } });
mock.module('./utils/notification-tray.js', { namedExports: { notificationTray: { set() {} } } });
mock.module('./utils/gateway-origin.js', {
  namedExports: {
    gatewayHttpOrigin: () => 'http://preview.test',
    gatewayHttpFetch: async () => {
      fetches++;
      return response;
    },
  },
});
const { readVerifiedArtifactPreview } = await import('./artifact-response.js');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('preview verifies selected bytes before storing and reopens them without a fetch', async (t) => {
  cache = createGatewayResourceCache({
    store: createMemoryResourceStore(),
    transport: {
      getConnection: () => ({
        id: 1,
        connected: true,
        authMode: 'none',
        scope: { gatewayUrl: 'ws://preview.test' },
      }),
      onConnectionChange: () => () => {},
      onResourceChanged: () => () => {},
      resynchronize() {},
      request: () => new Promise(() => {}),
    },
  });
  const current = cache;
  t.after(async () => {
    await current.dispose();
    cache = undefined;
  });
  const bytes = new TextEncoder().encode('before\nmatching line\nafter');
  const key = { kind: 'artifact' as const, id: sha(bytes) };
  const signal = new AbortController().signal;
  response = new Response(bytes.slice().buffer);
  fetches = 0;
  assert.deepEqual(
    await readVerifiedArtifactPreview('/api/run-artifact?path=proof.log', key.id, signal),
    bytes,
  );
  const deadline = Date.now() + 1000;
  while (!(await current.openContent(key))) {
    assert(Date.now() < deadline, 'verified content was not stored');
    await setImmediate();
  }
  assert.deepEqual(
    await readVerifiedArtifactPreview('/api/run-artifact?path=proof.log', key.id, signal),
    bytes,
  );
  assert.equal(fetches, 1);
  response = new Response('changed content');
  const wrongId = 'a'.repeat(64);
  await assert.rejects(
    readVerifiedArtifactPreview('/api/run-artifact?path=other.log', wrongId, signal),
    /File changed/,
  );
  assert.equal(await current.openContent({ kind: 'artifact', id: wrongId }), undefined);
});

test('an oversized streamed preview cancels the reader at the 512 KiB cap', async () => {
  let cancelled = false;
  response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    readVerifiedArtifactPreview(
      '/api/run-artifact?path=large.log',
      'b'.repeat(64),
      new AbortController().signal,
    ),
    /too large/,
  );
  assert.equal(cancelled, true);
});
