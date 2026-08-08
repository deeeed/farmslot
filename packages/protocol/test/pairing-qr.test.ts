import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGatewayPairingQrPayload } from '../src/rpc/auth.js';

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
