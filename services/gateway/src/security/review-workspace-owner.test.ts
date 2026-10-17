import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialStoreRuntime, CredentialStoreWriter } from '@farmslot/credential-store';

import { nativeOwnerAssignedMachines } from './native-node.js';
import { ownsLocalNativeProfile } from './native-owner.js';
import {
  assertNativeRunOwner,
  resolveNativeWorkerOwner,
  resolveReviewWorkspaceOwner,
} from './native-worker-owner.js';
import {
  currentSessionPrincipal,
  runWithSessionOriginator,
  runWithSystemOriginator,
} from './work-originator.js';

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
  const other = writer.createPrincipal({ type: 'service', displayName: 'Other owner' }, [
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
  const admin = writer.createPrincipal({ type: 'person', displayName: 'Admin supervisor' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const operator = writer.createPrincipal({ type: 'person', displayName: 'Operator' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  runWithSessionOriginator(admin, () => {
    assert.equal(resolveReviewWorkspaceOwner(owner.id), owner.id);
    assert.equal(resolveNativeWorkerOwner('local-owner'), 'local-owner');
    // Historical runs remain inspectable after their runner owner was retired.
    // Transport authorization still uses that recorded owner, never the viewer.
    assert.equal(resolveReviewWorkspaceOwner('retired-service'), 'retired-service');
    assert.equal(resolveNativeWorkerOwner('retired-service'), 'retired-service');
    assert.throws(() => resolveReviewWorkspaceOwner(), /owned execution node/);
    const run = {
      transport: 'native' as const,
      nativeOwnerPrincipalId: owner.id,
      reviewWorkspaceTarget: { machine: 'remote' },
      agentContexts: [],
    };
    assert.doesNotThrow(() => assertNativeRunOwner(run));
    assert.equal(run.nativeOwnerPrincipalId, owner.id);
    assert.equal(currentSessionPrincipal()?.id, admin.id);
    runWithSystemOriginator(() => assert.equal(currentSessionPrincipal(), undefined));
    assert.equal(currentSessionPrincipal()?.id, admin.id);
  });
  runWithSessionOriginator(operator, () => {
    assert.throws(() => resolveReviewWorkspaceOwner(owner.id), /another principal/);
    assert.throws(() => resolveNativeWorkerOwner('local-owner'), /another principal/);
  });
  runWithSystemOriginator(() => {
    assert.equal(resolveReviewWorkspaceOwner(owner.id), owner.id);
    assert.throws(() => resolveReviewWorkspaceOwner(), /another principal/);
  });
});

test('native ownership never passes to a replacement at a reused id', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'native-owner-generation-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'arthur';
  t.after(() => {
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    if (oldOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = oldOwner;
    rmSync(home, { recursive: true, force: true });
  });
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  const writer = new CredentialStoreWriter(runtime);
  const admin = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const original = writer.createPrincipal(
    { type: 'person', displayName: 'Arthur' },
    admin,
    'arthur',
  );
  runWithSessionOriginator(original, () => {
    assert.equal(resolveNativeWorkerOwner(), 'arthur');
    assert.equal(resolveReviewWorkspaceOwner(), 'arthur');
  });
  const supervisor = writer.createPrincipal({ type: 'person', displayName: 'Lead' }, admin);
  writer.issueCredential(supervisor.id, 'lead');
  writer.retirePrincipals(['arthur']);
  const replacement = writer.createPrincipal(
    { type: 'person', displayName: 'Arthur' },
    admin,
    'arthur',
    { reuseRetiredId: true },
  );
  assert.equal(replacement.generation, 1);
  // Misconfiguration the retirement precondition cannot see: the configured
  // owner and a node binding both name the reused id.
  writer.createPrincipal(
    {
      type: 'node',
      displayName: 'Review node',
      machine: 'remote',
      nativeOwnerPrincipalId: 'arthur',
    },
    [],
  );
  runWithSessionOriginator(replacement, () => {
    assert.throws(() => resolveNativeWorkerOwner(), /arthur is a replacement identity/);
    assert.throws(() => resolveReviewWorkspaceOwner(), /arthur is a replacement identity/);
  });
  // Supervision checks the stored owner, so an old run under the reused id stops.
  runWithSessionOriginator(supervisor, () => {
    assert.throws(() => resolveReviewWorkspaceOwner('arthur'), /arthur is a replacement identity/);
    assert.throws(() => resolveNativeWorkerOwner('arthur'), /arthur is a replacement identity/);
  });
  assert.equal(ownsLocalNativeProfile('arthur'), false);
  assert.equal(nativeOwnerAssignedMachines(runtime.snapshot().principals, 'arthur').size, 0);
});
