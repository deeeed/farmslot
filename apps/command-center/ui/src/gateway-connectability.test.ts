import assert from 'node:assert/strict';
import test from 'node:test';

import { filterConnectableGatewayUrls, isInsecureWebSocketBlocked } from './gateway-url.js';

const httpsPage = { protocol: 'https:', host: 'farmslot.io' };
const httpPage = { protocol: 'http:', host: 'localhost:5174' };

// Chrome 150+ blocks every insecure ws:// from an https origin — including localhost, which
// used to be exempt. So from an https page NO ws:// candidate can connect.
test('any ws:// candidate is blocked from an HTTPS page, including localhost', () => {
  assert.equal(isInsecureWebSocketBlocked('ws://192.168.4.150:7777/ws', httpsPage), true);
  assert.equal(isInsecureWebSocketBlocked('ws://localhost:7777/ws', httpsPage), true);
  assert.equal(isInsecureWebSocketBlocked('ws://127.0.0.1:7777/ws', httpsPage), true);
});

test('wss:// is allowed from an HTTPS page regardless of host', () => {
  assert.equal(isInsecureWebSocketBlocked('wss://gateway.example/ws', httpsPage), false);
});

test('nothing is blocked when the page itself is served over http', () => {
  assert.equal(isInsecureWebSocketBlocked('ws://192.168.4.150:7777/ws', httpPage), false);
  assert.equal(isInsecureWebSocketBlocked('ws://localhost:7777/ws', httpPage), false);
});

test('filter separates blocked ws:// from reachable wss:// on an HTTPS page', () => {
  const { connectable, blocked } = filterConnectableGatewayUrls(
    ['wss://gateway.example/ws', 'ws://localhost:7777/ws'],
    httpsPage,
  );
  assert.deepEqual(connectable, ['wss://gateway.example/ws']);
  assert.deepEqual(blocked, ['ws://localhost:7777/ws']);
});

test('filter reports every candidate blocked when only ws:// is offered on HTTPS', () => {
  const candidates = ['ws://localhost:7777/ws', 'ws://192.168.4.150:7777/ws'];
  const { connectable, blocked } = filterConnectableGatewayUrls(candidates, httpsPage);
  assert.deepEqual(connectable, []);
  assert.deepEqual(blocked, candidates);
});

test('filter leaves ws:// candidates connectable on an http page', () => {
  const candidates = ['ws://localhost:5174/ws', 'ws://192.168.4.150:7777/ws'];
  const { connectable, blocked } = filterConnectableGatewayUrls(candidates, httpPage);
  assert.deepEqual(connectable, candidates);
  assert.deepEqual(blocked, []);
});
