import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTailscaleDnsNameFromStatus } from '@farmslot/protocol';

import { pairingAuthority } from './pair.js';

test('parseTailscaleDnsNameFromStatus extracts MagicDNS without trailing dot', () => {
  assert.equal(
    parseTailscaleDnsNameFromStatus(
      JSON.stringify({ Self: { DNSName: 'macbook.tailnet.ts.net.' } }),
    ),
    'macbook.tailnet.ts.net',
  );
});

test('parseTailscaleDnsNameFromStatus treats absent or malformed status as unavailable', () => {
  assert.equal(parseTailscaleDnsNameFromStatus(JSON.stringify({ Self: {} })), null);
  assert.equal(parseTailscaleDnsNameFromStatus('not json'), null);
});

test('pairing CLI has no implicit authority default', () => {
  assert.throws(() => pairingAuthority({}), /exactly one/u);
  assert.throws(
    () => pairingAuthority({ principal: 'owner', newService: 'phone' }),
    /exactly one/u,
  );
  assert.throws(() => pairingAuthority({ newService: 'phone' }), /requires at least one --role/u);
  assert.deepEqual(pairingAuthority({ principal: 'owner' }), {
    kind: 'existing-principal',
    principalId: 'owner',
  });
});
