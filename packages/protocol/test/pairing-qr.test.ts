import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGatewayPairingLink,
  buildGatewayPairingQrPayload,
  COMPANION_APP_SCHEMES,
} from '../src/rpc/auth.js';

test('multi-address pairing QR reuses one device code and expiry', () => {
  const payload = buildGatewayPairingQrPayload(
    {
      url: 'ws://127.0.0.1:7777/ws',
      code: 'one-device-code',
      profileName: 'Gateway',
      expiresAt: '2026-08-07T01:00:00.000Z',
    },
    [
      { gatewayUrl: 'ws://192.168.1.10:7777/ws', profileName: 'Mac (LAN)' },
      { gatewayUrl: 'ws://mac.tailnet.ts.net:7777/ws', profileName: 'Mac (Tailscale)' },
    ],
  );

  assert.deepEqual(
    payload.profiles.map(({ url, code, expiresAt }) => ({ url, code, expiresAt })),
    [
      {
        url: 'ws://192.168.1.10:7777/ws',
        code: 'one-device-code',
        expiresAt: '2026-08-07T01:00:00.000Z',
      },
      {
        url: 'ws://mac.tailnet.ts.net:7777/ws',
        code: 'one-device-code',
        expiresAt: '2026-08-07T01:00:00.000Z',
      },
    ],
  );
});

test('pairing QR rejects an empty profile set', () => {
  assert.throws(
    () =>
      buildGatewayPairingQrPayload(
        {
          url: 'ws://127.0.0.1:7777/ws',
          code: 'one-device-code',
          profileName: 'Gateway',
          expiresAt: '2026-08-07T01:00:00.000Z',
        },
        [],
      ),
    /requires at least one profile/u,
  );
});

test('pairing link carries the QR payload for each Companion build and survives a device shell', () => {
  const payload = buildGatewayPairingQrPayload(
    {
      url: 'ws://127.0.0.1:7777/ws',
      code: 'one-device-code',
      profileName: 'Gateway',
      expiresAt: '2026-08-07T01:00:00.000Z',
    },
    [{ gatewayUrl: 'ws://192.168.1.10:7777/ws', profileName: "Arthur's Mac (LAN) & *more*!" }],
  );
  for (const scheme of COMPANION_APP_SCHEMES) {
    const link = buildGatewayPairingLink(payload, scheme);
    const [target, encoded = ''] = link.split('?payload=');
    assert.equal(target, `${scheme}://pair`);
    assert.match(encoded, /^[A-Za-z0-9%._~-]+$/u);
    assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), payload);
  }
  assert.ok(buildGatewayPairingLink(payload).startsWith('farmslot://pair?payload='));
});
