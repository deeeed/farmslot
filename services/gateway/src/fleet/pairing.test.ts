import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type PairingCreateParams, parseTailscaleDnsNameFromStatus } from '@farmslot/protocol';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import { parseCredentialWire } from '../security/credential-secret.js';
import { loadCredentialStore } from '../security/credential-store.js';

import { pairingCreate, pairingExchange } from './pairing.js';

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
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-pairing-solo-')),
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

test('pairing exchange mints a derived revocable credential instead of returning the boot secret', () => {
  const runtime = initializedRuntime();
  const envCredential = runtime.store
    .snapshot()
    .credentials.find((credential) => credential.origin === 'env-migrated');
  assert.ok(envCredential);
  const code = pairingCreate(
    {
      gatewayUrl: 'ws://127.0.0.1:7777/ws',
      profileName: 'phone',
      authority: {
        kind: 'existing-principal',
        principalId: envCredential.principalId,
      },
    },
    runtime,
  );
  const exchanged = pairingExchange({ code: code.code }, runtime);
  assert.notEqual(exchanged.profile.secret, 'boot-token');
  const parsed = parseCredentialWire(exchanged.profile.secret);
  assert.ok(parsed);
  const paired = runtime.store.findCredential(parsed.credentialId);
  assert.equal(paired?.origin, 'paired');
  assert.equal(paired?.principalId, envCredential.principalId);
  assert.equal(runtime.resolver.resolveSecret(exchanged.profile.secret, 'token').ok, true);

  runtime.writer.revokeCredential(parsed.credentialId);
  assert.equal(runtime.resolver.resolveSecret(exchanged.profile.secret, 'token').ok, false);
  assert.equal(runtime.resolver.resolveSecret('boot-token', 'token').ok, true);
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
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-pairing-test-')),
    FARMSLOT_GATEWAY_TOKEN: 'boot-token',
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  return runtime;
}
