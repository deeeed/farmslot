import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type CredentialStore,
  CredentialStoreRuntime,
  hashSecret,
  loadCredentialStore,
  withCredentialStoreLock,
} from '@farmslot/credential-store';

import { authenticateGatewayClient, createGatewayAuthRuntime } from './auth.js';

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'credential-origin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'credentials.json');
  const date = '2026-01-01T00:00:00.000Z';
  const secret = hashSecret('synthetic-origin-proof');
  const store: CredentialStore = {
    schemaVersion: 2,
    personSessions: [],
    personAccessTokens: [],
    activatedAt: date,
    principals: [
      {
        id: 'automation',
        subject: { type: 'service', displayName: 'automation' },
        roles: [{ role: 'admin', scope: { kind: 'global' } }],
      },
      {
        id: 'node-proof',
        subject: {
          type: 'node',
          displayName: 'node-proof',
          machine: 'proof',
          nativeOwnerPrincipalId: 'automation',
        },
        roles: [],
      },
    ],
    credentials: (['issued', 'paired', 'issued', 'issued'] as const).map((origin, index) => ({
      id: String(index + 1).repeat(32),
      principalId: 'automation',
      displayName: `device-${index}`,
      secret,
      origin,
      createdAt: date,
      revokedAt: index === 3 ? date : null,
    })),
    retiredPrincipalIds: ['retired-person'],
    retiredCredentialIds: ['retired-credential'],
  };
  const historical = {
    ...store,
    schemaVersion: 1,
    credentials: store.credentials.map((record, index) => ({
      ...record,
      origin: index >= 2 ? 'env-migrated' : record.origin,
    })),
  };
  writeFileSync(path, JSON.stringify(historical), { mode: 0o600 });
  return { home, path, store, historical, env: { FARMSLOT_HOME: home } };
}

test('gateway boots with historical origins and preserves authority, secrets and revocations', (t) => {
  const f = fixture(t);
  const runtime = createGatewayAuthRuntime(f.env);
  assert.equal(runtime.auth.mode, 'token');
  assert.deepEqual(runtime.store.snapshot(), f.store);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), f.store);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.home).mode & 0o777, 0o700);
  assert.equal(runtime.store.findPrincipal('node-proof')?.subject.type, 'node');
  for (const [index, credential] of f.store.credentials.entries()) {
    assert.equal(
      authenticateGatewayClient({
        runtime,
        connectParams: {
          clientKind: 'ui',
          token: `fs_${credential.id}_synthetic-origin-proof`,
        },
        clientIp: '127.0.0.1',
      }).ok,
      index !== 3,
    );
  }
  assert.equal(
    authenticateGatewayClient({
      runtime,
      connectParams: { clientKind: 'ui', token: 'synthetic-origin-proof' },
      clientIp: '127.0.0.1',
    }).ok,
    false,
  );
  const bytes = readFileSync(f.path);
  const stamp = statSync(f.path);
  createGatewayAuthRuntime(f.env);
  loadCredentialStore(f.path);
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(statSync(f.path).ino, stamp.ino);
  assert.equal(statSync(f.path).mtimeMs, stamp.mtimeMs);
});

test('migration uses the supplied path and reuses an already-held writer lock', (t) => {
  const f = fixture(t);
  // The fixture home differs from process.env, so this also guards path selection.
  assert.deepEqual(loadCredentialStore(f.path), f.store);
  writeFileSync(f.path, JSON.stringify(f.historical));
  withCredentialStoreLock(
    (store) => {
      assert.deepEqual(store, f.store);
      return { next: { ...store, retiredPrincipalIds: ['retired-person', 'next'] }, result: null };
    },
    { env: f.env },
  );
  assert.deepEqual(loadCredentialStore(f.path).retiredPrincipalIds, ['retired-person', 'next']);
});

test('invalid surviving records and unknown origins refuse boot without rewriting', (t) => {
  const f = fixture(t);
  for (const invalid of [
    { ...f.historical, schemaVersion: 99 },
    { ...f.historical, principals: [{ ...f.store.principals[0], roles: ['invalid'] }] },
    {
      ...f.historical,
      credentials: [
        { ...f.historical.credentials[0], origin: 'unknown' },
        ...f.historical.credentials.slice(1),
      ],
    },
    {
      ...f.historical,
      credentials: [
        { ...f.historical.credentials[0], secret: null },
        ...f.historical.credentials.slice(1),
      ],
    },
  ]) {
    const bytes = JSON.stringify(invalid);
    writeFileSync(f.path, bytes);
    assert.throws(() => createGatewayAuthRuntime(f.env), /Invalid credential store/);
    assert.equal(readFileSync(f.path, 'utf8'), bytes);
    assert.throws(() => statSync(join(f.home, 'credentials.lock')), { code: 'ENOENT' });
  }
});

test('a live writer lock refuses migration without altering the store', (t) => {
  const f = fixture(t);
  const bytes = readFileSync(f.path);
  writeFileSync(join(f.home, 'credentials.lock'), `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => loadCredentialStore(f.path), /Another Farmslot process/);
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('runtime refresh migrates metadata without emitting authority changes', (t) => {
  const f = fixture(t);
  const runtime = new CredentialStoreRuntime(f.env);
  const changes: unknown[] = [];
  runtime.onChange((change) => changes.push(change));
  writeFileSync(f.path, JSON.stringify(f.historical));
  assert.deepEqual(runtime.snapshot(), f.store);
  assert.deepEqual(changes, []);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), f.store);
});
