import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activePersonAccess,
  CredentialStoreRefusalError,
  CredentialStoreRuntime,
  CredentialStoreWriter,
  loadCredentialStore,
  parsePersonSessionToken,
  type PersonSessionAuthority,
} from '@farmslot/credential-store';
import type { PersonSessionGrant } from '@farmslot/protocol';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'person-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: root });
  const clock = { now: Date.now() };
  const writer = new CredentialStoreWriter(runtime, false, () => clock.now);
  const person = writer.createPrincipal({ type: 'person', displayName: 'Person' }, []);
  const credential = writer.issueCredential(person.id, 'Sign-in credential');
  const device = { deviceName: 'Test device', deviceKind: 'cli' as const };
  const grant = () => writer.exchangePersonCredential(credential.secret, device);
  return { runtime, clock, writer, person, credential, device, grant };
}

function authority(grant: PersonSessionGrant): PersonSessionAuthority {
  const access = parsePersonSessionToken(grant.accessToken, 'fsa');
  assert.ok(access);
  return {
    principalId: grant.session.principalId,
    principalGeneration: grant.session.principalGeneration,
    sessionId: grant.session.id,
    accessId: access.id,
  };
}

function ended(error: unknown): boolean {
  return error instanceof CredentialStoreRefusalError && error.diagnostic === 'AUTH_SESSION_ENDED';
}

test('schema1 migration preserves credentials and bytes on a second read', (t) => {
  const f = fixture(t);
  const admin = f.writer.createPrincipal({ type: 'service', displayName: 'Retained admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  f.writer.issueCredential(admin.id, 'Retained automation credential');
  const historical = f.writer.createPrincipal({ type: 'person', displayName: 'Historical' }, []);
  f.writer.retirePrincipals([historical.id]);
  f.writer.createPrincipal({ type: 'person', displayName: 'Replacement' }, [], historical.id, {
    reuseRetiredId: true,
  });
  const before = f.runtime.snapshot();
  const legacy = Object.fromEntries(
    Object.entries(before).filter(
      ([key]) => key !== 'personSessions' && key !== 'personAccessTokens',
    ),
  );
  writeFileSync(f.runtime.path, JSON.stringify({ ...legacy, schemaVersion: 1 }));
  const after = loadCredentialStore(f.runtime.path);
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.principals, before.principals);
  assert.deepEqual(after.credentials, before.credentials);
  assert.deepEqual(after.principalIdReuses, before.principalIdReuses);
  assert.deepEqual(after.retiredPrincipalIds, before.retiredPrincipalIds);
  assert.deepEqual(after.personSessions, []);
  assert.deepEqual(after.personAccessTokens, []);
  const saved = readFileSync(f.runtime.path, 'utf8');
  loadCredentialStore(f.runtime.path);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), saved);
});

test('issued tokens are hash-only on disk and survive a runtime restart', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  assert.equal(Date.parse(grant.accessExpiresAt) - f.clock.now, 3_600_000);
  assert.equal(Date.parse(grant.session.refreshExpiresAt) - f.clock.now, 2_592_000_000);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  for (const secret of [f.credential.secret, grant.accessToken, grant.refreshToken])
    assert.ok(!bytes.includes(secret));
  assert.ok(!('refreshSecret' in grant.session));
  const restarted = new CredentialStoreRuntime(f.runtime.env);
  assert.equal(
    activePersonAccess(restarted.snapshot(), authority(grant).accessId, f.clock.now)?.session.id,
    grant.session.id,
  );
});

test('access expires exactly at one hour without any store write', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  const id = authority(grant).accessId;
  const bytes = readFileSync(f.runtime.path, 'utf8');
  f.clock.now += 3_600_000 - 1;
  assert.ok(activePersonAccess(f.runtime.snapshot(), id, f.clock.now));
  f.clock.now++;
  assert.equal(activePersonAccess(f.runtime.snapshot(), id, f.clock.now), undefined);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});

test('refresh slides thirty days, keeps concurrent access and refuses exact expiry', (t) => {
  const f = fixture(t);
  const first = f.grant();
  f.clock.now += 60_000;
  const refreshed = f.writer.refreshPersonSession(first.refreshToken);
  assert.equal(refreshed.refreshToken, first.refreshToken);
  assert.equal(Date.parse(refreshed.session.refreshExpiresAt), f.clock.now + 2_592_000_000);
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(first).accessId, f.clock.now));
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(refreshed).accessId, f.clock.now));
  f.clock.now = Date.parse(refreshed.session.refreshExpiresAt);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(() => f.writer.refreshPersonSession(first.refreshToken), ended);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});

test('device revocation is independent, idempotent and cannot cross a person boundary', (t) => {
  const f = fixture(t);
  const first = f.grant();
  const second = f.grant();
  const otherPerson = f.writer.createPrincipal({ type: 'person', displayName: 'Other' }, []);
  const other = f.writer.issuePersonSession(otherPerson.id, 0, f.device);
  const actor = authority(first);
  const revoked = f.writer.revokePersonSession(actor, second.session.id);
  assert.ok(revoked.revokedAt);
  assert.deepEqual(f.writer.revokePersonSession(actor, second.session.id), revoked);
  assert.equal(
    activePersonAccess(f.runtime.snapshot(), authority(second).accessId, f.clock.now),
    undefined,
  );
  assert.ok(activePersonAccess(f.runtime.snapshot(), actor.accessId, f.clock.now));
  assert.ok(activePersonAccess(f.runtime.snapshot(), authority(other).accessId, f.clock.now));
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(
    () => f.writer.revokePersonSession(actor, other.session.id),
    (error: unknown) =>
      error instanceof CredentialStoreRefusalError && error.diagnostic === 'AUTH_FORBIDDEN',
  );
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
  assert.equal(f.writer.listPersonSessions(actor).length, 2);
});

test('source credential revocation closes device tokens and refresh authority', (t) => {
  const f = fixture(t);
  const grant = f.grant();
  let invalidated: string[] = [];
  f.runtime.onChange((change) => {
    invalidated = change.revokedSessionIds ?? [];
  });
  f.writer.revokeCredential(f.credential.record.id);
  assert.deepEqual(invalidated, [grant.session.id]);
  assert.equal(
    activePersonAccess(f.runtime.snapshot(), authority(grant).accessId, f.clock.now),
    undefined,
  );
  assert.throws(() => f.writer.refreshPersonSession(grant.refreshToken), ended);
});

test('a revoked acting device cannot mutate another device while its person still exists', (t) => {
  const f = fixture(t);
  const first = f.grant();
  const second = f.grant();
  const actor = authority(first);
  f.writer.revokePersonSession(authority(second), first.session.id);
  const bytes = readFileSync(f.runtime.path, 'utf8');
  assert.throws(() => f.writer.revokePersonSession(actor, second.session.id), ended);
  assert.equal(readFileSync(f.runtime.path, 'utf8'), bytes);
});
