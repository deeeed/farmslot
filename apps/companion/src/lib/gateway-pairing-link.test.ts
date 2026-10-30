import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { buildGatewayPairingLink, buildGatewayPairingQrPayload } from '@farmslot/protocol';

mock.module('expo-constants', { defaultExport: { expoConfig: { extra: {} } } });
mock.module('expo-secure-store', {
  namedExports: {
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
  },
});
let pairing: typeof import('./gateway-pairing');
test.before(async () => {
  pairing = await import('./gateway-pairing');
});

test('a pair link hands the pairing the same payload its QR would', () => {
  const payload = buildGatewayPairingQrPayload(
    {
      url: 'ws://127.0.0.1:7801/ws',
      code: 'one-device-code',
      profileName: 'macwork',
      expiresAt: '2026-10-30T04:00:00.000Z',
    },
    [
      { gatewayUrl: 'ws://192.168.128.52:7801/ws', profileName: 'macwork (LAN)' },
      { gatewayUrl: 'ws://macwork.tail73dab7.ts.net:7801/ws', profileName: 'macwork (Tailscale)' },
    ],
  );
  const link = buildGatewayPairingLink(payload, 'farmslot-development');
  // The router decodes the query once, as URLSearchParams does.
  const routed = new URL(link).searchParams.get('payload');
  assert.ok(routed);
  assert.deepEqual(
    pairing.parseGatewayPairingQr(routed),
    pairing.parseGatewayPairingQr(JSON.stringify(payload)),
  );
});
