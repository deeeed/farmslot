import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeGatewayPairingQr } from './gateway-pairing-exchange';
import { profileFromPairingExchange } from './gateway-pairing-normalization';
import { sortPairingExchangeUrls } from './gateway-pairing-urls';
import {
  gatewayProfileKindUrlError,
  inferGatewayProfileKindFromUrl,
  requiresSecureRemoteUrl,
} from './gateway-profile-kind';
import { sortGatewayProfilesForAutoConnect as sortGatewayProfilesForAutoConnectFromSelection } from './gateway-profile-selection';
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

test('multi-profile pairing exchanges once and shares one revocable device credential', async () => {
  const calls: Array<{ urls: string[]; code: string }> = [];
  const profiles = await exchangeGatewayPairingQr(
    {
      type: 'farmslot.gateway-pairing.v1',
      profiles: [
        {
          url: 'ws://192.168.0.18:7777/ws',
          code: 'lan-code',
          profileName: 'MacBook (LAN)',
        },
        {
          url: 'ws://macwork.tail73dab7.ts.net:7777/ws',
          code: 'lan-code',
          profileName: 'MacBook (Tailscale)',
        },
      ],
    },
    async (urls, code) => {
      calls.push({ urls, code });
      return {
        profile: {
          name: 'Gateway self URL',
          url: 'ws://localhost:7777/ws',
          authMode: 'token',
          secret: 'one-device-secret',
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  );

  assert.deepEqual(calls, [
    {
      urls: ['ws://macwork.tail73dab7.ts.net:7777/ws', 'ws://192.168.0.18:7777/ws'],
      code: 'lan-code',
    },
  ]);
  assert.deepEqual(
    profiles.map(({ name, url, secret }) => ({ name, url, secret })),
    [
      {
        name: 'MacBook (LAN)',
        url: 'ws://192.168.0.18:7777/ws',
        secret: 'one-device-secret',
      },
      {
        name: 'MacBook (Tailscale)',
        url: 'ws://macwork.tail73dab7.ts.net:7777/ws',
        secret: 'one-device-secret',
      },
    ],
  );
});

test('multi-profile pairing rejects mixed device codes before exchange', async () => {
  let exchangeCalled = false;
  await assert.rejects(
    exchangeGatewayPairingQr(
      {
        type: 'farmslot.gateway-pairing.v1',
        profiles: [
          { url: 'ws://192.168.0.18:7777/ws', code: 'lan-code' },
          { url: 'ws://macwork.tail73dab7.ts.net:7777/ws', code: 'tailnet-code' },
        ],
      },
      async () => {
        exchangeCalled = true;
        throw new Error('exchange should not run');
      },
    ),
    /contains multiple device codes/u,
  );
  assert.equal(exchangeCalled, false);
});

test('sortPairingExchangeUrls tries Tailscale before LAN for QR exchange', () => {
  assert.deepEqual(
    sortPairingExchangeUrls([
      'ws://192.168.0.18:7777/ws',
      'ws://macwork.tail73dab7.ts.net:7777/ws',
      'wss://farmslot.siteed.net/ws',
    ]),
    [
      'ws://macwork.tail73dab7.ts.net:7777/ws',
      'wss://farmslot.siteed.net/ws',
      'ws://192.168.0.18:7777/ws',
    ],
  );
});

test('plain ws Tailscale MagicDNS is classified as tailnet', () => {
  assert.equal(inferGatewayProfileKindFromUrl('ws://macbook.tailnet.ts.net:7777/ws'), 'tailnet');
});

test('tailnet detection requires the actual hostname to be in the tailnet namespace', () => {
  assert.equal(inferGatewayProfileKindFromUrl('ws://evil.ts.net.attacker.example/ws'), 'lan');
  assert.equal(inferGatewayProfileKindFromUrl('ws://foo.tailnet-x.evil.example/ws'), 'lan');
});

test('tailnet profiles may use ws while remote profiles still require wss', () => {
  assert.equal(
    requiresSecureRemoteUrl({ kind: 'tailnet', url: 'ws://macbook.tailnet.ts.net:7777/ws' }),
    false,
  );
  assert.equal(requiresSecureRemoteUrl({ kind: 'remote', url: 'ws://gateway.example/ws' }), true);
  assert.equal(requiresSecureRemoteUrl({ kind: 'remote', url: 'wss://gateway.example/ws' }), false);
});

test('tailnet manual profile kind requires a Tailscale MagicDNS URL', () => {
  assert.equal(
    gatewayProfileKindUrlError({ kind: 'tailnet', url: 'ws://gateway.example/ws' }),
    'Tailnet profiles must use a Tailscale MagicDNS .ts.net URL.',
  );
  assert.equal(
    gatewayProfileKindUrlError({ kind: 'tailnet', url: 'ws://macbook.tailnet.ts.net/ws' }),
    null,
  );
});
