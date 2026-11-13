import assert from 'node:assert/strict';
import test from 'node:test';

import { noChange, nothing } from 'lit';
import { PartType } from 'lit/directive.js';

import { clearGatewayMemoryAuth } from '../../gateway-url.js';
import { installFakeGateway } from '../../testing/fake-gateway.js';

import { GatewayMedia } from './gateway-media-src.js';

// Its own file: the gateway client singleton must not have been disconnected by another test.
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

test('a held failure loads once more when the gateway connection comes back', async (t) => {
  const fake = installFakeGateway(t);
  Object.defineProperty(window, 'location', {
    value: {
      ...location,
      origin: 'http://localhost:1234',
      href: 'http://localhost:1234/',
      pathname: '/',
    },
    configurable: true,
  });
  const { gateway } = await import('../../gateway-client.js');
  t.after(() => {
    gateway.disconnect();
    clearGatewayMemoryAuth();
  });
  fake.authPayload = {
    ok: true,
    authMode: 'token',
    principal: {
      id: 'media-owner',
      subjectKind: 'service',
      displayName: 'Media owner',
      roles: [{ role: 'viewer', scope: { kind: 'global' } }],
    },
    capabilities: { workspaceAccess: 'farm' },
  };
  await gateway.setAuthCredentials({ token: 'media-fixture' });
  gateway.connect();
  const settle = async () => {
    for (let i = 0; i < 20; i++) await flush();
  };
  await settle();
  assert.equal(gateway.connectionState, 'connected');
  const answers: Array<() => Response> = [
    () => new Response('Artifact was not retained', { status: 404 }),
    () => {
      throw new TypeError('Failed to fetch');
    },
    () => new Response('Gateway restarting', { status: 503 }),
    () => new Response('bytes', { headers: { 'content-type': 'image/png' } }),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => answers[calls++]!());
  t.mock.method(URL, 'createObjectURL', () => 'blob:recovered-media');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(console, 'error', () => {});
  const view = new MediaHarness({
    type: PartType.ATTRIBUTE,
    name: 'src',
    strings: ['', ''],
    tagName: 'IMG',
  });
  const url = '/api/file?slotId=slot-1&path=screen.png';
  const reconnect = async () => {
    fake.restart();
    assert.equal(gateway.connectionState, 'disconnected');
    gateway.connect();
    await settle();
    assert.equal(gateway.connectionState, 'connected');
    await settle();
  };
  view.render(url);
  await settle();
  // 404, network error and 503 each stay held across re-renders until the connection returns.
  for (const expected of [1, 2, 3]) {
    assert.equal(calls, expected);
    for (let i = 0; i < 3; i++) assert.equal(view.render(url), noChange);
    await settle();
    assert.equal(calls, expected, 'a re-render does not fetch a held failure again');
    await reconnect();
  }
  assert.equal(calls, 4);
  assert.equal(view.values.at(-1), 'blob:recovered-media');
  assert.ok(view.values.slice(0, -1).every((value) => value === nothing));
  // A loaded source does not refetch on a later reconnect.
  await reconnect();
  assert.equal(calls, 4);
  view.disconnect();
});
