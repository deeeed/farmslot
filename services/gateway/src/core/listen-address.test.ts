import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getGatewayListenSnapshot,
  isRemoteGatewayListenAllowed,
  normalizeListenHost,
  remotePairingBlockedHint,
  setGatewayListenAddress,
} from './listen-address.js';

test('normalizeListenHost defaults to all interfaces', () => {
  assert.equal(normalizeListenHost(undefined), '0.0.0.0');
  assert.equal(normalizeListenHost(''), '0.0.0.0');
});

test('isRemoteGatewayListenAllowed treats loopback and all-interfaces bind differently', () => {
  assert.equal(isRemoteGatewayListenAllowed('127.0.0.1'), false);
  assert.equal(isRemoteGatewayListenAllowed('localhost'), false);
  assert.equal(isRemoteGatewayListenAllowed('0.0.0.0'), true);
  assert.equal(isRemoteGatewayListenAllowed('::'), true);
});

test('setGatewayListenAddress records remote pairing availability', () => {
  setGatewayListenAddress('127.0.0.1', 7801);
  assert.deepEqual(getGatewayListenSnapshot(), {
    host: '127.0.0.1',
    port: 7801,
    remotePairingAllowed: false,
  });
  setGatewayListenAddress(undefined, 7777);
  assert.equal(getGatewayListenSnapshot()?.remotePairingAllowed, true);
});

test('remotePairingBlockedHint names the bind host and restart guidance', () => {
  assert.match(remotePairingBlockedHint('127.0.0.1', 7801), /127\.0\.0\.1:7801/);
  assert.match(remotePairingBlockedHint('127.0.0.1', 7801), /GATEWAY_HOST=0\.0\.0\.0/);
});
