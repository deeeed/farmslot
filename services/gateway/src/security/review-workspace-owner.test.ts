import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialStoreRuntime, CredentialStoreWriter } from '@farmslot/credential-store';

import {
  assertNativeRunOwner,
  resolveNativeWorkerOwner,
  resolveReviewWorkspaceOwner,
} from './native-worker-owner.js';
import { runWithSessionOriginator, runWithSystemOriginator } from './work-originator.js';

test('issued remote owners can own workspace reviews without owning the local runner profile', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'review-owner-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'local-owner';
  t.after(() => {
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    if (oldOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = oldOwner;
    rmSync(home, { recursive: true, force: true });
  });
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  const writer = new CredentialStoreWriter(runtime);
  const owner = writer.createPrincipal({ type: 'person', displayName: 'Remote owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const other = writer.createPrincipal({ type: 'person', displayName: 'Other owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  writer.createPrincipal(
    {
      type: 'node',
      displayName: 'Review node',
      machine: 'remote',
      nativeOwnerPrincipalId: owner.id,
    },
    [],
  );
  runWithSessionOriginator(owner, () => {
    assert.equal(resolveReviewWorkspaceOwner(), owner.id);
    assert.throws(() => resolveNativeWorkerOwner(), /configured native runner profile/);
    assert.doesNotThrow(() =>
      assertNativeRunOwner({
        transport: 'native',
        nativeOwnerPrincipalId: owner.id,
        reviewWorkspaceTarget: { machine: 'remote' },
        agentContexts: [],
      }),
    );
  });
  runWithSessionOriginator(other, () => {
    assert.throws(() => resolveReviewWorkspaceOwner(), /owned execution node/);
    assert.throws(() => resolveReviewWorkspaceOwner(owner.id), /another principal/);
  });
  runWithSystemOriginator(() => {
    assert.equal(resolveReviewWorkspaceOwner(owner.id), owner.id);
    assert.throws(() => resolveReviewWorkspaceOwner(), /another principal/);
  });
});
