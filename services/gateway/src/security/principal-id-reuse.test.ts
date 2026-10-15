import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CredentialStoreRefusalError,
  CredentialStoreWriter,
  loadCredentialStore,
  registerGatewayPresence,
  validateCredentialStore,
} from '@farmslot/credential-store';

import { pairingCreate, pairingExchange } from '../fleet/pairing.js';

import { createGatewayAuthRuntime } from './auth.js';
import {
  currentSessionOriginator,
  principalWorkOriginator,
  resolveWorkOriginator,
  runWithSessionOriginator,
  sessionOriginatorFor,
} from './work-originator.js';

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'principal-id-reuse-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { FARMSLOT_HOME: home };
  const auth = createGatewayAuthRuntime(env);
  const runtime = auth.store;
  const writer = new CredentialStoreWriter(runtime, true);
  writer.createPrincipal({ type: 'service', displayName: 'automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const admin = writer.issueCredential('automation', 'automation');
  writer.createPrincipal({ type: 'service', displayName: 'arthur' }, []);
  const old = writer.issueCredential('arthur', 'old device');
  writer.revokeCredential(old.record.id);
  writer.retirePrincipals(['arthur']);
  return { home, env, runtime, writer, admin, old, auth };
}

const person = { type: 'person', displayName: 'Arthur' } as const;

test('a pending invitation cannot issue for a retired principal replacement', (t) => {
  const f = fixture(t);
  f.writer.createPrincipal({ type: 'service', displayName: 'invited' }, []);
  const params = {
    gatewayUrl: 'ws://127.0.0.1:1/ws',
    authority: { kind: 'existing-principal' as const, principalId: 'invited' },
  };
  const invitation = pairingCreate(params, f.auth);
  f.writer.retirePrincipals(['invited']);
  f.writer.createPrincipal(person, [], 'invited', { reuseRetiredId: true });
  const before = readFileSync(f.runtime.path);
  assert.throws(() => pairingExchange({ code: invitation.code }, f.auth), {
    code: 'PAIRING_FAILED',
  });
  assert.deepEqual(readFileSync(f.runtime.path), before);
  const fresh = pairingCreate(params, f.auth);
  const exchanged = pairingExchange({ code: fresh.code }, f.auth);
  const authenticated = f.auth.resolver.resolveSecret(exchanged.profile.secret, 'token');
  assert.equal(authenticated.ok, true);
  if (authenticated.ok) assert.equal(authenticated.principal.generation, 1);
});

test('credential issuance checks expected identity in the locked disk transaction', (t) => {
  const f = fixture(t);
  // f.auth.writer reads the same disk store, even if another writer made the replacement.
  f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  const before = readFileSync(f.runtime.path);
  assert.throws(
    () => f.auth.writer.issueCredential('arthur', 'old grant', 'paired', 0),
    CredentialStoreRefusalError,
  );
  assert.deepEqual(readFileSync(f.runtime.path), before);
  assert.equal(
    f.auth.writer.issueCredential('arthur', 'fresh grant', 'paired', 1).record.origin,
    'paired',
  );
});

test('explicit reuse preserves retired credential ids and records a replacement without issuing', (t) => {
  const f = fixture(t);
  f.writer.createPrincipal({ type: 'service', displayName: 'unrelated' }, []);
  f.writer.retirePrincipals(['unrelated']);
  const before = structuredClone(f.runtime.snapshot());
  const replacement = f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  assert.equal(replacement.id, 'arthur');
  assert.equal(replacement.subject.type, 'person');
  assert.equal(replacement.generation, 1);
  const stored = loadCredentialStore(f.runtime.path);
  assert.deepEqual(stored.credentials, before.credentials);
  assert.deepEqual(stored.retiredCredentialIds, [f.old.record.id]);
  assert.deepEqual(stored.retiredPrincipalIds, ['unrelated']);
  assert.equal(stored.activatedAt, before.activatedAt);
  assert.equal(stored.principalIdReuses?.length, 1);
  assert.equal(stored.principalIdReuses?.[0].principalId, 'arthur');
  assert.ok(Number.isFinite(Date.parse(stored.principalIdReuses![0].reusedAt)));
  assert.equal(f.runtime.findCredential(f.old.record.id), undefined);
  const issued = f.writer.issueCredential('arthur', 'new device');
  assert.notEqual(issued.record.id, f.old.record.id);
  assert.deepEqual(loadCredentialStore(f.runtime.path).retiredCredentialIds, [f.old.record.id]);
});

test('normal creation still refuses a retired id and automatic naming skips it', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.runtime.path);
  assert.throws(() => f.writer.createPrincipal(person, [], 'arthur'), /has been retired/);
  assert.deepEqual(readFileSync(f.runtime.path), before);
  assert.equal(f.writer.createPrincipal({ ...person, displayName: 'arthur' }, []).id, 'arthur-2');
});

test('reuse refuses missing, live, reserved and never-retired ids without writing', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.runtime.path);
  for (const id of [undefined, 'automation', 'local-admin', 'never-retired']) {
    assert.throws(() => f.writer.createPrincipal(person, [], id, { reuseRetiredId: true }));
    assert.deepEqual(readFileSync(f.runtime.path), before);
  }
});

test('reuse history survives another retirement and reuse', (t) => {
  const f = fixture(t);
  f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  const first = structuredClone(f.runtime.snapshot().principalIdReuses);
  f.writer.retirePrincipals(['arthur']);
  f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  const stored = loadCredentialStore(f.runtime.path);
  assert.equal(stored.principalIdReuses?.length, 2);
  assert.equal(stored.principalIdReuses?.at(-1)?.generation, 2);
  assert.equal(f.runtime.findPrincipal('arthur')?.generation, 2);
  assert.deepEqual(stored.principalIdReuses?.slice(0, 1), first);
  assert.deepEqual(stored.retiredCredentialIds, [f.old.record.id]);
});

test('reuse history rejects malformed ids or timestamps while old stores remain valid', (t) => {
  const f = fixture(t);
  const base = f.runtime.snapshot();
  validateCredentialStore(base, f.runtime.path);
  for (const history of [
    {},
    [{ principalId: '', generation: 1, reusedAt: new Date().toISOString() }],
    [{ principalId: 'local-admin', generation: 1, reusedAt: new Date().toISOString() }],
    [{ principalId: 'arthur', generation: 1, reusedAt: 'today' }],
    [null],
  ]) {
    assert.throws(
      () => validateCredentialStore({ ...base, principalIdReuses: history }, f.runtime.path),
      /principalIdReuses/,
    );
  }
});

test('offline reuse refuses while a gateway is live and succeeds after it stops', (t) => {
  const f = fixture(t);
  const release = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: f.home, port: 1 },
    f.env,
  );
  const before = readFileSync(f.runtime.path);
  try {
    assert.throws(
      () => f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true }),
      /gateway.*running|gateway.*live|gateway.*stopped/i,
    );
    assert.deepEqual(readFileSync(f.runtime.path), before);
  } finally {
    release();
  }
  assert.equal(
    f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true }).id,
    'arthur',
  );
});

test('replacement credentials authorize fresh work while old secrets and originators remain invalid', (t) => {
  const f = fixture(t);
  const oldOriginator = { kind: 'principal' as const, principalId: 'arthur' };
  const replacement = f.writer.createPrincipal(
    person,
    [{ role: 'admin', scope: { kind: 'global' } }],
    'arthur',
    { reuseRetiredId: true },
  );
  const fresh = f.writer.issueCredential('arthur', 'new person device');
  assert.equal(f.auth.resolver.resolveSecret(f.old.secret, 'token').ok, false);
  assert.equal(
    f.auth.resolver.resolveSessionPrincipal({
      authenticated: true,
      authentication: { kind: 'credential', credentialId: f.old.record.id },
    }).ok,
    false,
  );
  assert.equal(f.auth.resolver.resolveSecret(fresh.secret, 'token').ok, true);
  assert.equal(f.auth.resolver.resolvePrincipalId('arthur').ok, false);
  assert.equal(resolveWorkOriginator(f.auth, oldOriginator), null);
  const current = runWithSessionOriginator(replacement, currentSessionOriginator);
  assert.deepEqual(current, principalWorkOriginator(replacement));
  assert.deepEqual(
    sessionOriginatorFor(f.auth, {
      authenticated: true,
      authentication: { kind: 'credential', credentialId: fresh.record.id },
    }),
    current,
  );
  assert.equal(resolveWorkOriginator(f.auth, current)?.id, 'arthur');
  f.writer.revokeCredential(fresh.record.id);
  f.writer.retirePrincipals(['arthur']);
  f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  assert.equal(resolveWorkOriginator(f.auth, current), null);
  assert.equal(f.auth.resolver.resolveSecret(fresh.secret, 'token').ok, false);
});

test('store validation refuses mismatched live generations and nonsequential reuse history', (t) => {
  const f = fixture(t);
  f.writer.createPrincipal(person, [], 'arthur', { reuseRetiredId: true });
  const stored = structuredClone(f.runtime.snapshot());
  const history = {
    ...stored,
    principalIdReuses: stored.principalIdReuses!.map((entry) => ({ ...entry, generation: 2 })),
  };
  assert.throws(
    () => validateCredentialStore(history, f.runtime.path),
    /generations must increase/,
  );
  const live = {
    ...stored,
    principals: stored.principals.map((entry) =>
      entry.id === 'arthur' ? { ...entry, generation: 2 } : entry,
    ),
  };
  assert.throws(() => validateCredentialStore(live, f.runtime.path), /generation does not match/);
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = {
      ...stored,
      principalIdReuses: stored.principalIdReuses!.map((entry) => ({ ...entry, generation })),
    };
    assert.throws(() => validateCredentialStore(malformed, f.runtime.path), /principalIdReuses/);
  }
});
