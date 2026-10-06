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

async function endpoint(targets) {
  const cdp = await startCdpEndpoint((message, emit) => {
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
