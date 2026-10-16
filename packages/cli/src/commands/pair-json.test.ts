import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Command } from 'commander';
import * as QRCode from 'qrcode';

import type { PairingCandidate, PairingCreateResult } from '@farmslot/protocol';

import { OutputContext } from '../output.js';

const addresses: PairingCandidate[] = [
  {
    gatewayUrl: 'ws://remote.example.ts.net:7801/ws',
    profileName: 'remote (Tailscale)',
    kind: 'tailnet',
  },
  { gatewayUrl: 'ws://192.168.1.12:7801/ws', profileName: 'remote (LAN)', kind: 'lan' },
];
const pairing: PairingCreateResult = {
  url: addresses[0]!.gatewayUrl,
  code: 'test-only-pairing-code',
  profileName: addresses[0]!.profileName,
  expiresAt: '2030-01-01T00:00:00Z',
};
const calls: Array<{ method: string; params: unknown }> = [];
mock.module('../context.js', {
  namedExports: {
    resolveContext: () => ({
      client: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === 'pairing.candidates') return { candidates: addresses };
          assert.equal(method, 'pairing.create');
          return pairing;
        },
      },
      output: new OutputContext(true),
      target: { url: 'ws://127.0.0.1:7801/ws' },
    }),
  },
});
const { registerPairCommand } = await import('./pair.js');

test('JSON pairing uses gateway-owned addresses, emits one envelope and a scannable stderr QR', async (t) => {
  let stdout = '';
  let stderr = '';
  const out = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const err = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  const program = new Command().name('farmslot').option('--json');
  registerPairCommand(program);
  await program.parseAsync(['node', 'farmslot', '--json', 'pair', '--principal', 'owner']);
  out.mock.restore();
  err.mock.restore();
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.command, 'pair');
  assert.deepEqual(
    envelope.data.payload.profiles.map((p: { url: string }) => p.url),
    addresses.map((a) => a.gatewayUrl),
  );
  assert.equal(calls[0]?.method, 'pairing.candidates');
  assert.deepEqual(calls[1], {
    method: 'pairing.create',
    params: {
      gatewayUrl: addresses[0]!.gatewayUrl,
      profileName: addresses[0]!.profileName,
      authority: { kind: 'existing-principal', principalId: 'owner' },
    },
  });
  // Decode the output contract: the exact payload printed as JSON is the QR's input.
  const expected = await QRCode.toString(JSON.stringify(envelope.data.payload), {
    type: 'terminal',
    small: true,
  });
  assert.equal(stderr, `\n${expected}\n`);
  assert.doesNotMatch(stdout, /\u001b/);
});
