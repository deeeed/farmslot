import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTailscaleDnsNameFromStatus } from '@farmslot/protocol';

import { pairingAuthority, reachableAddressesForPairing } from './pair.js';

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

test('reachableAddressesForPairing includes LAN and Tailscale profiles', () => {
  const addresses = reachableAddressesForPairing(
    '7777',
    ['192.168.1.12'],
    'macbook.tailnet.ts.net',
  );

  assert.deepEqual(
    addresses.map((address) => address.url),
    ['ws://192.168.1.12:7777/ws', 'ws://macbook.tailnet.ts.net:7777/ws'],
  );
  assert.match(addresses[0]!.name, /\(LAN\)$/);
  assert.match(addresses[1]!.name, /\(Tailscale\)$/);
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
