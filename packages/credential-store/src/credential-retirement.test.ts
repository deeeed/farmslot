import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retirePrincipalsOffline } from './credential-retirement.js';
import { CredentialStoreRuntime, loadCredentialStore } from './credential-store.js';
import { CredentialStoreWriter } from './credential-store-writer.js';
import { registerGatewayPresence } from './gateway-presence.js';

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'credential-retirement-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { FARMSLOT_HOME: home };
  const runtime = new CredentialStoreRuntime(env);
  const writer = new CredentialStoreWriter(runtime, true);
  writer.createPrincipal({ type: 'service', displayName: 'farm-automation' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const admin = writer.issueCredential('farm-automation', 'automation');
  writer.createPrincipal({ type: 'node', displayName: 'node-a', machine: 'a' }, []);
  const node = writer.issueCredential('node-a', 'a');
  return { home, env, runtime, writer, admin, node };
}

test('retirement refuses active credentials without changing the store', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.runtime.path);
  assert.throws(() => f.writer.retirePrincipals(['node-a']), /Revoke every/);
  assert.deepEqual(readFileSync(f.runtime.path), before);
});

test('retirement reserves ids, retains activation and invalidates deleted references', (t) => {
  const f = fixture(t);
  f.writer.revokeCredential(f.node.record.id);
  const changes: unknown[] = [];
  f.runtime.onChange((change) => changes.push(change));
  assert.deepEqual(f.writer.retirePrincipals(['node-a']), {
    principalIds: ['node-a'],
    credentialIds: [f.node.record.id],
  });
  const store = f.runtime.snapshot();
  assert.ok(store.activatedAt);
  assert.equal(f.runtime.findPrincipal('node-a'), undefined);
  assert.equal(f.runtime.findCredential(f.node.record.id), undefined);
  assert.deepEqual(store.retiredPrincipalIds, ['node-a']);
  assert.deepEqual(store.retiredCredentialIds, [f.node.record.id]);
  assert.deepEqual(changes, [
    {
      revokedCredentialIds: [f.node.record.id],
      changedPrincipalIds: ['node-a'],
      activationLatched: false,
    },
  ]);
  assert.throws(
    () =>
      f.writer.createPrincipal(
        { type: 'node', displayName: 'replacement', machine: 'a' },
        [],
        'node-a',
      ),
    /has been retired/,
  );
  assert.equal(
    f.writer.createPrincipal({ type: 'node', displayName: 'node-a', machine: 'a' }, []).id,
    'node-a-2',
  );
});

test('a remaining native-owner binding prevents retiring its owner', (t) => {
  const f = fixture(t);
  f.writer.createPrincipal({ type: 'service', displayName: 'owner' }, []);
  f.writer.bindNativeOwner('node-a', 'owner');
  assert.throws(() => f.writer.retirePrincipals(['owner']), /bound nodes/);
  assert.equal(f.runtime.findPrincipal('node-a')?.subject.type, 'node');
});

test('offline cutover removes only selected revoked records and validates survivors', (t) => {
  const f = fixture(t);
  f.writer.revokeCredential(f.node.record.id);
  const input = JSON.parse(readFileSync(f.runtime.path, 'utf8'));
  input.credentials.find((record: { id: string }) => record.id === f.node.record.id).origin =
    'removed-origin';
  writeFileSync(f.runtime.path, JSON.stringify(input));
  assert.throws(() => loadCredentialStore(f.runtime.path), /credential.*invalid/);
  const adminBefore = input.credentials.find(
    (record: { id: string }) => record.id === f.admin.record.id,
  );
  assert.deepEqual(retirePrincipalsOffline(['node-a'], f.env).credentialIds, [f.node.record.id]);
  assert.deepEqual(loadCredentialStore(f.runtime.path).credentials, [adminBefore]);

  f.writer.createPrincipal({ type: 'service', displayName: 'probe' }, []);
  const corrupt = JSON.parse(readFileSync(f.runtime.path, 'utf8'));
  corrupt.credentials[0].origin = 'unknown';
  writeFileSync(f.runtime.path, JSON.stringify(corrupt));
  const before = readFileSync(f.runtime.path);
  assert.throws(() => retirePrincipalsOffline(['probe'], f.env), /credential.*invalid/);
  assert.deepEqual(readFileSync(f.runtime.path), before);
});

test('offline retirement requires quiescence and a surviving admin', (t) => {
  const f = fixture(t);
  f.writer.revokeCredential(f.node.record.id);
  const release = registerGatewayPresence(
    { pid: process.pid, farmslotRoot: f.home, port: 1 },
    f.env,
  );
  try {
    assert.throws(
      () => retirePrincipalsOffline(['node-a'], f.env),
      /gateway.*running|gateway.*live|gateway.*stopped/i,
    );
  } finally {
    release();
  }
  f.writer.revokeCredential(f.admin.record.id);
  assert.throws(() => retirePrincipalsOffline(['node-a'], f.env), /surviving admin/);
});
