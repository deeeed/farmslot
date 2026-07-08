import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHostedGatewayCandidates } from './up.js';

test('hosted candidates are ws:// only when TLS is inactive', () => {
  const candidates = buildHostedGatewayCandidates(7777, null, 'mac', ['192.168.1.5']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    ['ws://localhost:7777/ws', 'ws://192.168.1.5:7777/ws'],
  );
});

test('hosted candidates lead with wss:// when TLS is active, keeping ws:// as fallback', () => {
  const candidates = buildHostedGatewayCandidates(7777, 7778, 'mac', ['192.168.1.5']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      'wss://localhost:7778/ws',
      'wss://192.168.1.5:7778/ws',
      'ws://localhost:7777/ws',
      'ws://192.168.1.5:7777/ws',
    ],
  );
  // A hosted HTTPS Command Center picks the first reachable candidate — it must be wss://.
  assert.match(candidates[0].url, /^wss:\/\//);
});

test('hosted candidates cover every LAN address on both transports', () => {
  const candidates = buildHostedGatewayCandidates(7777, 7778, 'mac', ['10.0.0.2', '10.0.0.3']);
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      'wss://localhost:7778/ws',
      'wss://10.0.0.2:7778/ws',
      'wss://10.0.0.3:7778/ws',
      'ws://localhost:7777/ws',
      'ws://10.0.0.2:7777/ws',
      'ws://10.0.0.3:7777/ws',
    ],
  );
});
