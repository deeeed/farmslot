import assert from 'node:assert/strict';
import test from 'node:test';

import { html, noChange, nothing } from 'lit';
import { PartType } from 'lit/directive.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ReadyGatePayload } from '@farmslot/protocol';

import { clearGatewayMemoryAuth, setGatewayMemoryAuth } from '../../gateway-url.js';
import { gatewayApiUrl } from '../../utils/gateway-origin.js';
import { renderReadyPrPreviewTab } from '../workspace/ready-workspace-tab-renderers.js';

import {
  GatewayMedia,
  GatewayMediaDocument,
  gatewayMediaHtml,
  loadGatewayMedia,
  requiresGatewayMediaHeaders,
} from './gateway-media-src.js';

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

test('unauthenticated and external media keep their existing direct URLs', async () => {
  const abort = new AbortController();
  clearGatewayMemoryAuth();
  assert.equal(
    (await loadGatewayMedia('https://outside.example/image.png', abort.signal)).url,
    'https://outside.example/image.png',
  );
});

for (const auth of [{ token: 'service-fixture' }, { password: 'password-fixture' }]) {
  test(`Markdown media removes URL credentials and uses ${auth.token ? 'Bearer' : 'Basic'} headers`, async (t) => {
    setGatewayMemoryAuth(auth, 'ws://localhost:7777/ws');
    t.after(clearGatewayMemoryAuth);
    const calls: Array<{ url: string; authorization: string | null }> = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response('image-bytes', { headers: { 'content-type': 'image/png' } });
    });
    const media = await loadGatewayMedia(
      'http://localhost:7777/api/run-artifact?path=proof.png&bundleDigest=frozen&token=old&password=old',
      new AbortController().signal,
    );
    t.after(media.dispose);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'http://localhost:7777/api/run-artifact?path=proof.png&bundleDigest=frozen',
    );
    assert.equal(
      calls[0].authorization,
      auth.token ? `Bearer ${auth.token}` : `Basic ${btoa(`:${auth.password}`)}`,
    );
    assert.ok(media.url.startsWith('blob:'));
  });
}

class MediaHarness extends GatewayMedia {
  values: unknown[] = [];
  override setValue(value: unknown): void {
    this.values.push(value);
  }
  disconnect(): void {
    this.disconnected();
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Markdown HTML uses the shared document loader and releases it with the view', async (t) => {
  setGatewayMemoryAuth(
    { token: `fsa_${'a'.repeat(32)}_${'b'.repeat(43)}` },
    'ws://localhost:7777/ws',
  );
  t.after(clearGatewayMemoryAuth);
  const input = '<p>Proof</p><img src="/api/run-artifact?path=proof.png">';
  const rewritten = '<p>Proof</p><img src="blob:proof">';
  const calls: string[] = [];
  t.mock.method(GatewayMediaDocument.prototype, 'html', async (value: string) => {
    calls.push(value);
    return rewritten;
  });
  const dispose = t.mock.method(GatewayMediaDocument.prototype, 'dispose', () => {});
  const view = new MediaHarness({ type: PartType.CHILD });
  assert.equal(view.render(input, 'html'), nothing);
  await flush();
  assert.deepEqual(calls, [input]);
  assert.deepEqual(view.values, [unsafeHTML(rewritten)]);
  assert.equal(view.render(input, 'html'), noChange);
  view.disconnect();
  assert.equal(dispose.mock.callCount(), 1);
});

test('closing pending Markdown disposes partial resources and refuses a late update', async (t) => {
  setGatewayMemoryAuth({ token: 'service-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  let finish: (value: string) => void = () => assert.fail('document loader not started');
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  t.mock.method(GatewayMediaDocument.prototype, 'html', () => pending);
  const dispose = t.mock.method(GatewayMediaDocument.prototype, 'dispose', () => {});
  const view = new MediaHarness({ type: PartType.CHILD });
  view.render('<img src="/api/file?path=proof.png">', 'html');
  view.disconnect();
  assert.equal(dispose.mock.callCount(), 1);
  finish('<img src="blob:late">');
  await flush();
  assert.deepEqual(view.values, []);
});

test('the real PR-preview renderer binds Markdown to the authenticated HTML transport', () => {
  const payload: ReadyGatePayload = {
    kind: 'ready',
    branch: 'branch',
    prNumber: null,
    repo: null,
    workerReport: 'Done',
    diffStat: { files: 0, additions: 0, deletions: 0 },
    reviews: [],
    prPackage: {
      id: 'package',
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Review' },
      publicationTarget: 'draft',
      publicationStatus: 'not_published',
      packageHash: 'a'.repeat(64),
      artifactPath: 'artifacts/pr-package.json',
      branch: 'branch',
      headSha: 'b'.repeat(40),
      diffStat: { files: 0, additions: 0, deletions: 0 },
      draftTitle: 'Title',
      draftBody: 'Body',
      reviewArtifactIds: [],
      createdAt: '2026-10-16T00:00:00Z',
    },
  };
  const markup = '<img src="/api/run-artifact?path=proof.png">';
  const rendered = renderReadyPrPreviewTab({
    payload,
    publicationTarget: 'draft',
    markdown: markup,
    fallback: () => html``,
  });
  const transport = rendered.values.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      '_$litDirective$' in value &&
      value._$litDirective$ === GatewayMedia,
  );
  assert.deepEqual(transport, gatewayMediaHtml(markup));
});

test('placeholder links cannot hide authenticated Markdown', (t) => {
  setGatewayMemoryAuth({ token: 'service-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  assert.equal(requiresGatewayMediaHeaders('http://localhost:PORT/#runs'), false);
  assert.equal(requiresGatewayMediaHeaders('http://localhost:${PORT}/#runs'), false);
  assert.equal(requiresGatewayMediaHeaders('/api/file?path=proof.png'), true);
});

test('Markdown text renders before media and survives an unexpected loader failure', async (t) => {
  setGatewayMemoryAuth({ token: 'service-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  const safeText = '<p>Review stays readable</p><img alt="Pending image">';
  const input = '<p>Review stays readable</p><img src="/api/file?path=proof.png">';
  t.mock.method(
    GatewayMediaDocument.prototype,
    'html',
    async function (this: GatewayMediaDocument) {
      this.initialHtml = safeText;
      throw new Error('Unexpected document failure');
    },
  );
  t.mock.method(console, 'error', () => {});
  const view = new MediaHarness({ type: PartType.CHILD });
  assert.deepEqual(view.render(input, 'html'), unsafeHTML(safeText));
  await flush();
  assert.deepEqual(view.values, [unsafeHTML(safeText)]);
  assert.deepEqual(view.render(input, 'html'), unsafeHTML(safeText));
  view.disconnect();
});
