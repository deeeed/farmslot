import assert from 'node:assert/strict';
import test from 'node:test';

import { filterConnectableGatewayUrls, isInsecureWebSocketBlocked } from './gateway-url.js';

const httpsPage = { protocol: 'https:', host: 'farmslot.io' };
const httpPage = { protocol: 'http:', host: 'localhost:5174' };

test('insecure ws:// to a non-loopback host is blocked from an HTTPS page', () => {
  assert.equal(isInsecureWebSocketBlocked('ws://192.168.4.150:7777/ws', httpsPage), true);
});

test('ws:// to loopback hosts is allowed from an HTTPS page', () => {
  assert.equal(isInsecureWebSocketBlocked('ws://localhost:7777/ws', httpsPage), false);
  assert.equal(isInsecureWebSocketBlocked('ws://127.0.0.1:7777/ws', httpsPage), false);
});

test('wss:// is allowed from an HTTPS page regardless of host', () => {
  assert.equal(isInsecureWebSocketBlocked('wss://gateway.example/ws', httpsPage), false);
});

test('nothing is blocked when the page itself is served over http', () => {
  assert.equal(isInsecureWebSocketBlocked('ws://192.168.4.150:7777/ws', httpPage), false);
});

test('filter drops mixed-content-blocked LAN candidates on HTTPS and reports them', () => {
  const { urls, skipped } = filterConnectableGatewayUrls(
    ['ws://localhost:7777/ws', 'ws://192.168.4.150:7777/ws'],
    httpsPage,
  );
  assert.deepEqual(urls, ['ws://localhost:7777/ws']);
  assert.deepEqual(skipped, ['ws://192.168.4.150:7777/ws']);
});

test('filter keeps originals when every candidate would be blocked', () => {
  const candidates = ['ws://192.168.4.150:7777/ws', 'ws://10.0.0.2:7777/ws'];
  const { urls, skipped } = filterConnectableGatewayUrls(candidates, httpsPage);
  assert.deepEqual(urls, candidates);
  assert.deepEqual(skipped, []);
});

test('filter leaves candidates untouched on an http page', () => {
  const candidates = ['ws://localhost:5174/ws', 'ws://192.168.4.150:7777/ws'];
  const { urls, skipped } = filterConnectableGatewayUrls(candidates, httpPage);
  assert.deepEqual(urls, candidates);
  assert.deepEqual(skipped, []);
});
