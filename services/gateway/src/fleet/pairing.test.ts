import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTailscaleDnsNameFromStatus } from './pairing.js';

test('parseTailscaleDnsNameFromStatus extracts MagicDNS without trailing dot', () => {
  assert.equal(
    parseTailscaleDnsNameFromStatus(
      JSON.stringify({ Self: { DNSName: 'macwork.tail73dab7.ts.net.' } }),
    ),
    'macwork.tail73dab7.ts.net',
  );
});

test('parseTailscaleDnsNameFromStatus treats absent and malformed status as unavailable', () => {
  assert.equal(parseTailscaleDnsNameFromStatus(JSON.stringify({ Self: {} })), null);
  assert.equal(parseTailscaleDnsNameFromStatus('not json'), null);
});
