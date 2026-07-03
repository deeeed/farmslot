import assert from 'node:assert/strict';
import test from 'node:test';

import { pairingWebSocketConnectionError } from './gateway-pairing-errors';

test('pairingWebSocketConnectionError explains LAN bind requirement for non-loopback URLs', () => {
  const error = pairingWebSocketConnectionError('ws://192.168.0.26:7801/ws');
  assert.match(error.message, /GATEWAY_HOST=0\.0\.0\.0/);
  assert.match(error.message, /192\.168\.0\.26:7801/);
});

test('pairingWebSocketConnectionError keeps a short message for loopback URLs', () => {
  const error = pairingWebSocketConnectionError('ws://127.0.0.1:7801/ws');
  assert.equal(error.message, 'Pairing WebSocket connection failed');
});
