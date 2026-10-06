'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { createExtensionNetworkObserver } = require('../src/network-observer.cjs');
const { startCdpEndpoint } = require('./fixtures/cdp-endpoint.cjs');

const TARGETS = [
  { targetId: 'tab', type: 'page', url: 'https://example.com/' },
  { targetId: 'worker', type: 'service_worker', url: 'chrome-extension://ext/sw.js' },
  { targetId: 'home', type: 'page', url: 'chrome-extension://ext/home.html' },
];

let root;
const cleanups = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'network-observer-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

// `refuse(message)` makes a command fail with a CDP error.
async function endpoint(targets, refuse = () => false) {
  const cdp = await startCdpEndpoint((message, emit) => {
    if (refuse(message)) return new Error(`${message.method} refused`);
    if (message.method === 'Target.setDiscoverTargets') {
      for (const targetInfo of targets) emit('Target.targetCreated', { targetInfo });
    }
    if (message.method === 'Target.getTargets') return { targetInfos: targets };
    if (message.method === 'Target.attachToTarget') {
      return { sessionId: `S-${message.params.targetId}` };
    }
    return {};
  });
  cleanups.push(cdp.close);
  return cdp;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const enabledSessions = (calls, from = 0) =>
  calls
    .slice(from)
    .filter((call) => call.method === 'Network.enable')
    .map((call) => call.sessionId)
    .sort();

async function observe(cdp) {
  const observer = await createExtensionNetworkObserver({ cdpPort: cdp.port, runtimeDir: root });
  cleanups.push(() => observer.close());
  return observer;
}

describe('createExtensionNetworkObserver', () => {
  it('captures the Network requests of every extension target through the broker', async () => {
    const cdp = await endpoint(TARGETS);
    const observer = await createExtensionNetworkObserver({ cdpPort: cdp.port, runtimeDir: root });
    cleanups.push(() => observer.close());

    assert.deepEqual(
      cdp.calls
        .filter((call) => call.method === 'Target.attachToTarget')
        .map((call) => call.params),
      [
        { targetId: 'worker', flatten: true },
        { targetId: 'home', flatten: true },
      ],
    );
    assert.deepEqual(await observer.start({ id: 'cap' }), { id: 'cap', status: 'started' });
    assert.deepEqual(
      cdp.calls
        .filter((call) => call.method === 'Network.enable')
        .map((call) => call.sessionId)
        .sort(),
      ['S-home', 'S-worker'],
    );

    const request = (url) => ({ request: { url, method: 'POST' } });
    cdp.emit('Network.requestWillBeSent', request('https://api.example.com/v1/orders'), 'S-home');
    // Browser-level and foreign events are not the extension's traffic.
    cdp.emit('Network.requestWillBeSent', request('https://elsewhere.example/'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const summary = await observer.end('cap');

    assert.equal(summary.status, 'complete');
    assert.equal(summary.totalRequests, 1);
    assert.deepEqual(summary.requestsByHost, { 'api.example.com': 1 });
  });

  it('attaches to an extension target created during a capture', async () => {
    const cdp = await endpoint(TARGETS);
    const observer = await observe(cdp);
    await observer.start({ id: 'cap' });
    const popup = { targetId: 'popup', type: 'page', url: 'chrome-extension://ext/popup.html' };
    cdp.emit('Target.targetCreated', { targetInfo: popup });
    cdp.emit('Target.targetCreated', {
      targetInfo: { targetId: 'site', type: 'page', url: 'https://example.org/' },
    });
    await settle();

    const attached = cdp.calls.filter((call) => call.method === 'Target.attachToTarget');
    assert.deepEqual(attached.at(-1).params, { targetId: 'popup', flatten: true });
    assert.equal(attached.length, 3);
    assert.ok(enabledSessions(cdp.calls).includes('S-popup'));
    cdp.emit(
      'Network.requestWillBeSent',
      { request: { url: 'https://api.example.com/', method: 'GET' } },
      'S-popup',
    );
    await settle();
    assert.equal((await observer.end('cap')).totalRequests, 1);
  });

  it('stops sending to a target once it detaches', async () => {
    const cdp = await endpoint(TARGETS);
    const observer = await observe(cdp);
    await observer.start({ id: 'cap' });
    const before = cdp.calls.length;
    cdp.emit('Target.detachedFromTarget', { sessionId: 'S-worker' });
    await settle();

    assert.deepEqual(enabledSessions(cdp.calls, before), ['S-home']);
    const summary = await observer.end('cap');
    assert.equal(summary.reconnects, 1);
    assert.equal(summary.status, 'partial');
  });

  it('drops the session a command failed on and keeps the others', async () => {
    const cdp = await endpoint(
      TARGETS,
      (message) => message.method === 'Network.enable' && message.sessionId === 'S-worker',
    );
    const observer = await observe(cdp);
    await observer.start({ id: 'cap' });
    const first = await observer.end('cap');
    assert.equal(first.status, 'partial');
    assert.equal(first.reconnects, 1);

    const before = cdp.calls.length;
    await observer.start({ id: 'again' });
    assert.deepEqual(enabledSessions(cdp.calls, before), ['S-home']);
    assert.equal((await observer.end('again')).status, 'complete');
  });

  it('marks the capture partial when the browser connection closes', async () => {
    const cdp = await endpoint(TARGETS);
    const observer = await observe(cdp);
    await observer.start({ id: 'cap' });
    await cdp.close();
    await settle();

    const summary = await observer.end('cap');
    assert.equal(summary.reconnects, 1);
    assert.equal(summary.status, 'partial');
  });

  it('refuses a browser without a loaded extension and closes its connection', async () => {
    const cdp = await endpoint([TARGETS[0]]);
    await assert.rejects(
      createExtensionNetworkObserver({ cdpPort: cdp.port, runtimeDir: root }),
      /loaded extension target is unavailable/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cdp.clients(), 0);
  });

  it('requires a valid CDP port', async () => {
    await assert.rejects(
      createExtensionNetworkObserver({ cdpPort: 0, runtimeDir: root }),
      /requires a valid CDP port/u,
    );
  });
});
