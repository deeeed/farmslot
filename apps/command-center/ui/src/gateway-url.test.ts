import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseHostedGatewayConnection,
  resolveGatewayWebSocketUrl,
  resolveGatewayWebSocketUrls,
} from './gateway-url.js';

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

test('gateway websocket URL resolves hosted connection fragments', () => {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      gateways: [
        { url: 'ws://localhost:7777', label: 'Local' },
        { url: 'ws://192.168.1.10:7777/ws', label: 'LAN' },
      ],
      token: 'secret-token',
    }),
  ).toString('base64url');

  assert.deepEqual(
    resolveGatewayWebSocketUrls(undefined, {
      protocol: 'https:',
      host: 'farmslot.io',
      hash: `#doctor?connect=${payload}`,
    }),
    ['ws://localhost:7777/ws', 'ws://192.168.1.10:7777/ws'],
  );
  assert.deepEqual(parseHostedGatewayConnection(`#connect=${payload}`), {
    urls: ['ws://localhost:7777/ws', 'ws://192.168.1.10:7777/ws'],
    token: 'secret-token',
  });
});

test('gateway websocket URL can reuse stored candidates', () => {
  assert.deepEqual(
    resolveGatewayWebSocketUrls(
      undefined,
      { protocol: 'https:', host: 'farmslot.io', hash: '' },
      JSON.stringify(['ws://localhost:7777', 'https://gateway.example']),
    ),
    ['ws://localhost:7777/ws', 'wss://gateway.example/ws'],
  );
});

test('gateway websocket URL ignores malformed hosted and stored candidates', () => {
  assert.deepEqual(parseHostedGatewayConnection('#doctor?connect=not-base64-json'), { urls: [] });
  assert.deepEqual(
    resolveGatewayWebSocketUrls(
      undefined,
      { protocol: 'https:', host: 'farmslot.io', hash: '#doctor?connect=not-base64-json' },
      'not-json',
    ),
    ['wss://farmslot.io/ws'],
  );
});
