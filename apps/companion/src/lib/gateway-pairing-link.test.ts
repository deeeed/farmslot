import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { buildGatewayPairingLink, buildGatewayPairingQrPayload } from '@farmslot/protocol';

import { claimPairing, forgetLastPairing, releasePairing } from './gateway-pairing-claim';

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

test('a pair link asks first, naming its addresses and the saved profile it replaces', () => {
  const lanUrl = 'ws://192.168.128.52:7801/ws';
  const payload = pairing.parseGatewayPairingQr(
    JSON.stringify(
      buildGatewayPairingQrPayload(
        {
          url: lanUrl,
          code: 'one-device-code',
          profileName: 'macwork (LAN)',
          expiresAt: '2026-10-30T04:00:00.000Z',
        },
        [
          { gatewayUrl: lanUrl, profileName: 'macwork (LAN)' },
          { gatewayUrl: 'wss://gateway.example/ws', profileName: 'Remote' },
        ],
      ),
    ),
  );
  const prompt = pairing.pairingLinkPrompt(payload, [
    {
      id: pairing.profileIdForPairedProfile({ name: 'Home', url: lanUrl }),
      name: 'Home',
      url: lanUrl,
      kind: 'lan',
    },
    // Same address, but saved by hand: pairing saves its own profile beside it.
    { id: 'manual', name: 'Manual', url: lanUrl, kind: 'lan' },
  ]);
  assert.match(prompt, /^macwork \(LAN\): ws:\/\/192\.168\.128\.52:7801\/ws$/mu);
  assert.match(prompt, /^Remote: wss:\/\/gateway\.example\/ws$/mu);
  assert.match(prompt, /Replaces the saved profile and sign-in for Home\.$/mu);
  assert.doesNotMatch(prompt, /Manual/u);
});

test('pairing data a QR could not hold is refused before any exchange', () => {
  const profiles = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ url: `ws://10.0.0.${n}:7801/ws`, code: 'code' }));
  const data = (list: unknown[]) =>
    JSON.stringify({ type: 'farmslot.gateway-pairing.v1', profiles: list });
  assert.equal(pairing.parseGatewayPairingQr(data(profiles(16))).profiles.length, 16);
  assert.throws(() => pairing.parseGatewayPairingQr(data(profiles(17))), /at most 16/u);
  assert.throws(
    () =>
      pairing.parseGatewayPairingQr(
        data([{ url: 'ws://10.0.0.1:7801/ws', code: 'c'.repeat(5000) }]),
      ),
    /larger than any Farmslot pairing QR/u,
  );
});

test('one pairing runs at a time, across screens, and each payload once', () => {
  assert.equal(claimPairing('link A'), 'claimed');
  // Another link or a scan while A runs; the pair link tells the user.
  assert.equal(claimPairing('link B'), 'busy');
  // A again while it runs, e.g. its route remounted.
  assert.equal(claimPairing('link A'), 'handled');
  releasePairing();
  // A again after it ran: its code is spent.
  assert.equal(claimPairing('link A'), 'handled');
  assert.equal(claimPairing('link B'), 'claimed');
  releasePairing();
  // A reopened scanner may read the last QR again.
  forgetLastPairing();
  assert.equal(claimPairing('link B'), 'claimed');
  releasePairing();
});
