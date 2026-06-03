import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGatewayWebSocketUrl } from './gateway-url.js';

test('gateway websocket URL falls back when Vite env is absent or blank', () => {
  const location = { protocol: 'http:', host: 'localhost:5174' };

  assert.equal(resolveGatewayWebSocketUrl(undefined, location), 'ws://localhost:5174/ws');
  assert.equal(resolveGatewayWebSocketUrl('', location), 'ws://localhost:5174/ws');
  assert.equal(resolveGatewayWebSocketUrl('   ', location), 'ws://localhost:5174/ws');
});

test('gateway websocket URL preserves explicit configured endpoints', () => {
  assert.equal(
    resolveGatewayWebSocketUrl(' wss://gateway.example/ws ', {
      protocol: 'https:',
      host: 'ui.example',
    }),
    'wss://gateway.example/ws',
  );
  assert.equal(
    resolveGatewayWebSocketUrl(undefined, {
      protocol: 'https:',
      host: 'ui.example',
    }),
    'wss://ui.example/ws',
  );
});
