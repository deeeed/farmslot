import assert from 'node:assert/strict';
import test from 'node:test';

import { gatewayHealthUrlFromWs, localGatewayHealthCandidates } from './gateway-health.js';

test('gatewayHealthUrlFromWs maps loopback websocket URLs to /health', () => {
  assert.equal(gatewayHealthUrlFromWs('ws://127.0.0.1:7801/ws'), 'http://127.0.0.1:7801/health');
  assert.equal(gatewayHealthUrlFromWs('ws://192.168.0.26:7801/ws'), null);
});

test('localGatewayHealthCandidates includes env port and common dev defaults', () => {
  const previousPort = process.env.GATEWAY_PORT;
  process.env.GATEWAY_PORT = '7801';
  try {
    assert.deepEqual(localGatewayHealthCandidates().sort(), [
      'http://127.0.0.1:7777/health',
      'http://127.0.0.1:7801/health',
    ]);
  } finally {
    if (previousPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = previousPort;
  }
});
