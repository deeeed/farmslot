import assert from 'node:assert/strict';
import test from 'node:test';

import { clearGatewayMemoryAuth, setGatewayMemoryAuth } from '../../gateway-url.js';
import { gatewayApiUrl } from '../../utils/gateway-origin.js';

import { loadGatewayMedia } from './gateway-media-src.js';

test('person media uses headers, preserves bytes and releases its object URL', async (t) => {
  const token = `fsa_${'a'.repeat(32)}_${'b'.repeat(43)}`;
  setGatewayMemoryAuth({ token }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const released: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return new Response('image-bytes', { headers: { 'content-type': 'image/png' } });
  });
  let loaded: Blob | undefined;
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    loaded = blob;
    return 'blob:fixture-image';
  });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    released.push(url);
  });
  const url = gatewayApiUrl('/api/file?path=image.png&token=old');
  assert.ok(!url.includes('token='));
  const media = await loadGatewayMedia(url, new AbortController().signal);
  assert.equal(media.url, 'blob:fixture-image');
  assert.equal(await loaded?.text(), 'image-bytes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${token}`);
  assert.ok(!calls[0].url.includes(token));
  media.dispose();
  assert.deepEqual(released, ['blob:fixture-image']);
});

test('service and external media keep their existing direct URLs', async () => {
  const abort = new AbortController();
  clearGatewayMemoryAuth();
  assert.equal(
    (await loadGatewayMedia('https://outside.example/image.png', abort.signal)).url,
    'https://outside.example/image.png',
  );
});
