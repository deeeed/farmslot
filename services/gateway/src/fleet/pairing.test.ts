import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { type NetworkInterfaceInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const homes: string[] = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
function testHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

import { type PairingCreateParams, parseTailscaleDnsNameFromStatus } from '@farmslot/protocol';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import { parseCredentialWire } from '../security/credential-secret.js';
import { loadCredentialStore } from '../security/credential-store.js';

import { pairingCreate, pairingExchange, reachablePairingCandidates } from './pairing.js';

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

test('pairing requires explicit authority and validates existing principals at create time', () => {
  const runtime = initializedRuntime();
  assert.throws(
    () =>
      pairingCreate(
        {
          gatewayUrl: 'ws://127.0.0.1:7777/ws',
        } as PairingCreateParams,
        runtime,
      ),
    /requires authority/u,
  );
  assert.throws(
    () =>
      pairingCreate(
        {
          gatewayUrl: 'ws://127.0.0.1:7777/ws',
          authority: { kind: 'existing-principal', principalId: 'missing' },
        },
        runtime,
      ),
    /does not exist/u,
  );
});

test('pairing cannot become the first issuance and rejects malformed role bindings', () => {
  const solo = createGatewayAuthRuntime({
    FARMSLOT_HOME: testHome('farmslot-pairing-solo-'),
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(solo, { host: '127.0.0.1' });
  assert.throws(
    () =>
      pairingCreate(
        {
          gatewayUrl: 'ws://127.0.0.1:7777/ws',
          authority: {
            kind: 'new-service-principal',
            displayName: 'phone',
            roles: [{ role: 'operator', scope: { kind: 'global' } }],
          },
        },
        solo,
      ),
    /activated gateway/u,
  );

  const runtime = initializedRuntime();
  assert.throws(
    () =>
      pairingCreate(
        {
          gatewayUrl: 'ws://127.0.0.1:7777/ws',
          authority: {
            kind: 'new-service-principal',
            displayName: 'phone',
            roles: [{ role: 'operator', scope: { kind: 'farm' } } as never],
          },
        },
        runtime,
      ),
    /requires displayName and roles/u,
  );
});

test('pairing exchange mints a separately revocable credential', () => {
  const runtime = initializedRuntime();
  const issued = runtime.writer.issueCredential('test-automation', 'source-client');
  const code = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:7777/ws',
      profileName: 'phone',
      authority: {
        kind: 'existing-principal',
        principalId: issued.record.principalId,
      },
    },
    runtime,
  );
  const exchanged = pairingExchange({ code: code.code }, runtime);
  assert.notEqual(exchanged.profile.secret, issued.secret);
  const parsed = parseCredentialWire(exchanged.profile.secret);
  assert.ok(parsed);
  const paired = runtime.store.findCredential(parsed.credentialId);
  assert.equal(paired?.origin, 'paired');
  assert.equal(paired?.principalId, issued.record.principalId);
  assert.equal(runtime.resolver.resolveSecret(exchanged.profile.secret, 'token').ok, true);

  runtime.writer.revokeCredential(parsed.credentialId);
  assert.equal(runtime.resolver.resolveSecret(exchanged.profile.secret, 'token').ok, false);
  assert.equal(runtime.resolver.resolveSecret(issued.secret, 'token').ok, true);
});

test('new service principal is provisioned only when its pairing code is redeemed', () => {
  const runtime = initializedRuntime();
  const before = runtime.store.snapshot().principals.length;
  const unredeemed = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:7777/ws',
      authority: {
        kind: 'new-service-principal',
        displayName: 'unredeemed-phone',
        roles: [{ role: 'operator', scope: { kind: 'global' } }],
      },
    },
    runtime,
  );
  assert.ok(unredeemed.code);
  assert.equal(runtime.store.snapshot().principals.length, before);

  const redeemed = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:7777/ws',
      authority: {
        kind: 'new-service-principal',
        displayName: 'redeemed-phone',
        roles: [{ role: 'operator', scope: { kind: 'global' } }],
      },
    },
    runtime,
  );
  const exchanged = pairingExchange({ code: redeemed.code }, runtime);
  const parsed = parseCredentialWire(exchanged.profile.secret);
  assert.ok(parsed);
  const credential = runtime.store.findCredential(parsed.credentialId);
  const principal = credential ? runtime.store.findPrincipal(credential.principalId) : undefined;
  assert.equal(principal?.subject.displayName, 'redeemed-phone');
  assert.deepEqual(principal?.roles, [{ role: 'operator', scope: { kind: 'global' } }]);
});

test('failed new-service pairing leaves the store unchanged and can be retried', () => {
  const runtime = initializedRuntime();
  const code = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:7777/ws',
      profileName: 'retry-phone',
      authority: {
        kind: 'new-service-principal',
        displayName: 'retry-phone',
        roles: [{ role: 'operator', scope: { kind: 'global' } }],
      },
    },
    runtime,
  );
  const before = loadCredentialStore(runtime.store.path);
  const blockedTemporaryPath = `${runtime.store.path}.${process.pid}.tmp`;
  mkdirSync(blockedTemporaryPath);
  try {
    assert.throws(() => pairingExchange({ code: code.code }, runtime), /EISDIR/u);
    assert.deepEqual(loadCredentialStore(runtime.store.path), before);
  } finally {
    rmSync(blockedTemporaryPath, { recursive: true });
  }

  const exchanged = pairingExchange({ code: code.code }, runtime);
  const parsed = parseCredentialWire(exchanged.profile.secret);
  assert.ok(parsed);
  const after = loadCredentialStore(runtime.store.path);
  assert.equal(after.principals.length, before.principals.length + 1);
  assert.equal(after.credentials.length, before.credentials.length + 1);
  assert.equal(after.credentials.at(-1)?.id, parsed.credentialId);
});

function initializedRuntime() {
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: testHome('farmslot-pairing-test-'),
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  runtime.writer.createPrincipal({ type: 'service', displayName: 'test-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  runtime.writer.issueCredential('test-automation', 'test-client');
  return runtime;
}

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    internal,
    family: 'IPv4',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${address}/24`,
  };
}

test('pairing prefers Tailscale then LAN and excludes WireGuard/tunnel addresses', () => {
  const candidates = reachablePairingCandidates(
    7801,
    {
      utun0: [ipv4('10.8.0.2')],
      en0: [ipv4('192.168.1.12'), ipv4('10.8.1.2')],
      utun1: [ipv4('100.101.102.103')],
      tun0: [ipv4('172.20.0.2')],
      lo0: [ipv4('127.0.0.1', true)],
    },
    'gateway.example.ts.net',
    'gateway',
  );
  assert.deepEqual(
    candidates.map(({ gatewayUrl, kind }) => ({ gatewayUrl, kind })),
    [
      { gatewayUrl: 'ws://gateway.example.ts.net:7801/ws', kind: 'tailnet' },
      { gatewayUrl: 'ws://100.101.102.103:7801/ws', kind: 'tailnet' },
      { gatewayUrl: 'ws://192.168.1.12:7801/ws', kind: 'lan' },
    ],
  );
});

test('pairing without Tailscale uses deduplicated LAN and refuses tunnel-only hosts', () => {
  assert.deepEqual(
    reachablePairingCandidates(7801, { utun0: [ipv4('10.8.0.2')] }, null, 'gateway'),
    [],
  );
  const candidates = reachablePairingCandidates(
    7801,
    { en0: [ipv4('192.168.1.12')], bridge0: [ipv4('192.168.1.12')] },
    null,
    'gateway',
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.gatewayUrl, 'ws://192.168.1.12:7801/ws');
});

test('pairing retains public physical-interface fallback without advertising link-local addresses', () => {
  const candidates = reachablePairingCandidates(
    7801,
    { en0: [ipv4('203.0.113.12')], utun0: [ipv4('10.8.0.2')], en1: [ipv4('169.254.1.2')] },
    null,
    'gateway',
  );
  assert.deepEqual(
    candidates.map((c) => c.gatewayUrl),
    ['ws://203.0.113.12:7801/ws'],
  );
});
