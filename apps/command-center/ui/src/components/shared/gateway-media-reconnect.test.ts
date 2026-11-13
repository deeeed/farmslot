import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { noChange, nothing } from 'lit';
import { PartType } from 'lit/directive.js';

// A gateway whose connection the test drives: no socket, timer or shared client state.
type ConnectionState = 'connected' | 'disconnected';
const listeners = new Set<(state: ConnectionState) => void>();
const gateway = {
  connectionState: 'connected' as ConnectionState,
  onConnectionChange(callback: (state: ConnectionState) => void) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
const setConnection = (state: ConnectionState) => {
  gateway.connectionState = state;
  for (const listener of [...listeners]) listener(state);
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });

// A browser view: media requests wait on, and retry with, the gateway connection.
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost:7777/'),
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });

const { clearGatewayMemoryAuth, setGatewayMemoryAuth } = await import('../../gateway-url.js');
const { GatewayMedia } = await import('./gateway-media-src.js');

class MediaHarness extends GatewayMedia {
  values: unknown[] = [];
  override setValue(value: unknown): void {
    this.values.push(value);
  }
  disconnect(): void {
    this.disconnected();
  }
}

/** Failed media loads: each ends by logging this message. */
const mediaFailures = (errors: { mock: { calls: Array<{ arguments: unknown[] }> } }) =>
  errors.mock.calls.filter((call) => call.arguments[0] === 'Gateway media could not be loaded.')
    .length;

/** Waits for a condition, however many turns the load takes. */
async function until(description: string, condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `${description} never happened`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('a held failure loads once more when the gateway connection comes back', async (t) => {
  setGatewayMemoryAuth({ token: 'media-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
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
  t.mock.method(URL, 'revokeObjectURL', () => undefined);
  const errors = t.mock.method(console, 'error', () => undefined);
  const view = new MediaHarness({
    type: PartType.ATTRIBUTE,
    name: 'src',
    strings: ['', ''],
    tagName: 'IMG',
  });
  const url = '/api/file?slotId=slot-1&path=screen.png';
  view.render(url);
  // 404, network error and 503: each stays held across re-renders until the connection returns.
  for (const failure of [1, 2, 3]) {
    await until(`failed load ${failure}`, () => mediaFailures(errors) === failure);
    // The reconnect watch is registered once the failure settles.
    await until(`reconnect watch ${failure}`, () => listeners.size === 1);
    for (let i = 0; i < 3; i++) assert.equal(view.render(url), noChange);
    assert.equal(calls, failure, 'a re-render does not fetch a held failure again');
    setConnection('connected');
    assert.equal(calls, failure, 'a connection that never dropped does not reload');
    setConnection('disconnected');
    setConnection('connected');
  }
  await until(
    'the reload after the third reconnect',
    () => view.values.at(-1) === 'blob:recovered-media',
  );
  assert.equal(calls, 4);
  assert.ok(view.values.slice(0, -1).every((value) => value === nothing));
  // A loaded source has no watch: a later reconnect reads nothing again.
  assert.equal(listeners.size, 0);
  setConnection('disconnected');
  setConnection('connected');
  assert.equal(calls, 4);
  view.disconnect();
});

test('a closed view stops watching its held failure', async (t) => {
  setGatewayMemoryAuth({ token: 'media-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('Artifact was not retained', { status: 404 });
  });
  const errors = t.mock.method(console, 'error', () => undefined);
  const view = new MediaHarness({ type: PartType.CHILD });
  view.render('/api/run-artifact?runId=run-1&path=artifacts/diff.txt');
  await until('the failed load', () => mediaFailures(errors) === 1);
  await until('the reconnect watch', () => listeners.size === 1);
  view.disconnect();
  assert.equal(listeners.size, 0);
  setConnection('disconnected');
  setConnection('connected');
  assert.equal(calls, 1);
});
