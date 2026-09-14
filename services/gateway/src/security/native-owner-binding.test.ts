import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { CredentialStoreRuntime, loadCredentialStore } from './credential-store.js';
import { CredentialStoreWriter } from './credential-store-writer.js';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-native-owner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  return { runtime, writer: new CredentialStoreWriter(runtime) };
}

test('native owner assignment persists, is idempotent, and cannot be reassigned', (t) => {
  const { runtime, writer } = fixture(t);
  const first = writer.createPrincipal({ type: 'person', displayName: 'first' }, []);
  const second = writer.createPrincipal({ type: 'service', displayName: 'second' }, []);
  const node = writer.createPrincipal(
    { type: 'node', displayName: 'node', machine: 'private-node' },
    [],
  );
  const bound = writer.bindNativeOwner(node.id, first.id);
  assert.deepEqual(writer.bindNativeOwner(node.id, first.id), bound);
  assert.throws(() => writer.bindNativeOwner(node.id, second.id), /immutable/);
  assert.throws(() => writer.bindNativeOwner(first.id, second.id), /requires a node/);
  assert.deepEqual(
    new CredentialStoreRuntime(runtime.env)
      .snapshot()
      .principals.find((entry) => entry.id === node.id),
    bound,
  );
});

test('native assignment validates its referenced owner and reserves its machine atomically', (t) => {
  const { runtime, writer } = fixture(t);
  const owner = writer.createPrincipal({ type: 'person', displayName: 'owner' }, []);
  const node = writer.createPrincipal(
    { type: 'node', displayName: 'legacy', machine: 'private-node' },
    [],
  );
  for (const ownerId of ['missing', 'local-admin', node.id])
    assert.throws(
      () =>
        writer.createPrincipal(
          {
            type: 'node',
            displayName: 'invalid',
            machine: 'other-node',
            nativeOwnerPrincipalId: ownerId,
          },
          [],
        ),
      /stored person or service/,
    );
  assert.throws(
    () =>
      writer.createPrincipal(
        { type: 'node', displayName: 'local', machine: 'local', nativeOwnerPrincipalId: owner.id },
        [],
      ),
    /distinct execution node/,
  );
  writer.bindNativeOwner(node.id, owner.id);
  assert.throws(
    () =>
      writer.createPrincipal(
        {
          type: 'node',
          displayName: 'duplicate',
          machine: 'private-node',
          nativeOwnerPrincipalId: owner.id,
        },
        [],
      ),
    /already assigned/,
  );
  assert.equal(runtime.snapshot().principals.length, 2);
});

test('persisted native owner references fail closed when malformed or missing', (t) => {
  const { runtime, writer } = fixture(t);
  writer.createPrincipal({ type: 'node', displayName: 'node', machine: 'private-node' }, []);
  const original = readFileSync(runtime.path, 'utf8');
  for (const value of [42, '', 'missing']) {
    const store = JSON.parse(original);
    store.principals[0].subject.nativeOwnerPrincipalId = value;
    writeFileSync(runtime.path, JSON.stringify(store));
    assert.throws(() => loadCredentialStore(runtime.path), /native owner/);
  }
});
