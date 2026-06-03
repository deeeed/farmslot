import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLegacyLocalhostGatewayUrl,
  isMobileGatewayProfileUrl,
  mobileGatewayProfileUrlError,
} from './gateway-profile-validation';

test('mobile gateway profile URLs reject localhost and loopback hosts', () => {
  for (const url of [
    'ws://localhost:7777/ws',
    'ws://127.0.0.1:7777/ws',
    'ws://0.0.0.0:7777/ws',
    'ws://[::1]:7777/ws',
  ]) {
    assert.equal(isLegacyLocalhostGatewayUrl(url), true, url);
    assert.equal(isMobileGatewayProfileUrl(url), false, url);
    assert.match(mobileGatewayProfileUrlError(url) ?? '', /cannot use localhost/);
  }
});

test('mobile gateway profile URLs allow LAN DNS, LAN IP, and WSS remotes', () => {
  for (const url of [
    'ws://my-mac.local:7777/ws',
    'ws://192.168.50.10:7777/ws',
    'wss://gateway.example/ws',
  ]) {
    assert.equal(isLegacyLocalhostGatewayUrl(url), false, url);
    assert.equal(isMobileGatewayProfileUrl(url), true, url);
    assert.equal(mobileGatewayProfileUrlError(url), null, url);
  }
});

test('mobile gateway profile URLs require WebSocket protocols', () => {
  assert.equal(isMobileGatewayProfileUrl('http://my-mac.local:7777/ws'), false);
  assert.match(
    mobileGatewayProfileUrlError('http://my-mac.local:7777/ws') ?? '',
    new RegExp('must start with ws:// or wss://'),
  );
});
