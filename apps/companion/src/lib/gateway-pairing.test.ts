import assert from 'node:assert/strict';
import test from 'node:test';

import { profileFromPairingExchange } from './gateway-pairing-normalization';
import {
  selectPreferredGatewayProfile as selectPreferredGatewayProfileFromSelection,
  sortGatewayProfilesForAutoConnect as sortGatewayProfilesForAutoConnectFromSelection,
} from './gateway-profile-selection';
import { inferGatewayProfileKindFromUrl, requiresSecureRemoteUrl } from './gateway-profile-kind';
import type { GatewayProfile } from './gateway-profiles';

test('sortGatewayProfilesForAutoConnect prefers remote-capable profiles before LAN fallback', () => {
  const lan: GatewayProfile = {
    id: 'lan',
    name: 'LAN',
    url: 'ws://macbook.local:7777/ws',
    kind: 'lan',
  };
  const remote: GatewayProfile = {
    id: 'remote',
    name: 'Remote',
    url: 'wss://gateway.example/ws',
    kind: 'remote',
  };
  const tailnet: GatewayProfile = {
    id: 'tailnet',
    name: 'Tailnet',
    url: 'wss://macbook.tailnet-ts.net/ws',
    kind: 'tailnet',
  };
  const custom: GatewayProfile = {
    id: 'custom',
    name: 'Custom',
    url: 'ws://gateway.internal/ws',
    kind: 'custom',
  };

  assert.deepEqual(
    sortGatewayProfilesForAutoConnectFromSelection([custom, lan, remote, tailnet]).map(
      (profile) => profile.id,
    ),
    ['tailnet', 'remote', 'lan', 'custom'],
  );
});

test('selectPreferredGatewayProfile returns null when pairing imports no profiles', () => {
  assert.equal(selectPreferredGatewayProfileFromSelection([]), null);
});

test('profileFromPairingExchange keeps the QR mobile URL over gateway self URL', () => {
  const profile = profileFromPairingExchange(
    {
      url: 'wss://phone-reachable.example/ws',
      profileName: 'Phone Reachable',
    },
    {
      profile: {
        name: 'Gateway Self',
        url: 'ws://localhost:7777/ws',
        authMode: 'token',
        secret: 'secret-token',
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  );

  assert.equal(profile.name, 'Gateway Self');
  assert.equal(profile.url, 'wss://phone-reachable.example/ws');
  assert.equal(profile.authMode, 'token');
  assert.equal(profile.secret, 'secret-token');
});

test('plain ws Tailscale MagicDNS is classified as tailnet', () => {
  assert.equal(inferGatewayProfileKindFromUrl('ws://macbook.tailnet.ts.net:7777/ws'), 'tailnet');
});

test('tailnet profiles may use ws while remote profiles still require wss', () => {
  assert.equal(
    requiresSecureRemoteUrl({ kind: 'tailnet', url: 'ws://macbook.tailnet.ts.net:7777/ws' }),
    false,
  );
  assert.equal(requiresSecureRemoteUrl({ kind: 'remote', url: 'ws://gateway.example/ws' }), true);
  assert.equal(requiresSecureRemoteUrl({ kind: 'remote', url: 'wss://gateway.example/ws' }), false);
});
