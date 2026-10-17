import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialStoreRuntime, CredentialStoreWriter } from '@farmslot/credential-store';

import { buildRunRecord } from '../runs/store.js';

import { createGatewayAuthRuntime } from './auth.js';
import { authorizeStoredRunEffect } from './authorization.js';
import { nativeOwnerAssignedMachines } from './native-node.js';
import { ownsLocalNativeProfile } from './native-owner.js';
import {
  assertNativeRunOwner,
  resolveNativeWorkerOwner,
  resolveReviewWorkspaceOwner,
  resolveStaticReviewOwner,
} from './native-worker-owner.js';
import {
  currentSessionPrincipal,
  replacedWorkOriginator,
  resolveWorkOriginator,
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

test('an admin person without native ownership delegates static review to the native owner', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'static-review-delegation-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'farm-automation';
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
  const automation = writer.createPrincipal(
    { type: 'service', displayName: 'Automation' },
    admin,
    'farm-automation',
  );
  writer.issueCredential(automation.id, 'automation');
  writer.createPrincipal({ type: 'person', displayName: 'Arthur' }, admin, 'arthur');
  writer.retirePrincipals(['arthur']);
  const arthur = writer.createPrincipal(
    { type: 'person', displayName: 'Arthur' },
    admin,
    'arthur',
    {
      reuseRetiredId: true,
    },
  );
  const observer = writer.createPrincipal({ type: 'person', displayName: 'Observer' }, []);
  const nodeOwner = writer.createPrincipal({ type: 'person', displayName: 'Node owner' }, admin);
  writer.createPrincipal(
    { type: 'node', displayName: 'Own node', machine: 'own', nativeOwnerPrincipalId: nodeOwner.id },
    [],
  );

  const review = {
    project: 'demo',
    flowType: 'review-pr' as const,
    ticketOrPr: 'owner/repo#1',
    transport: 'tmux' as const,
    reviewWorkspaceTarget: { machine: 'own' },
  };
  runWithSessionOriginator(arthur, () => {
    assert.deepEqual(resolveStaticReviewOwner('live'), {
      ownerId: 'farm-automation',
      requester: { principalId: 'arthur', principalGeneration: 1 },
    });
    // The run belongs to the native owner; the requester is audit only.
    const run = buildRunRecord(review, { delegatedReviewOwner: 'farm-automation' });
    assert.equal(run.createdByPrincipalId, 'farm-automation');
    assert.equal(run.createdByPrincipalGeneration, undefined);
    assert.equal(run.nativeOwnerPrincipalId, 'farm-automation');
    assert.equal(run.requestedByPrincipalId, 'arthur');
    assert.equal(run.requestedByPrincipalGeneration, 1);
    // A wire request carrying the requester field is refused.
    const supplied = Object.assign({ ...review }, { requestedByPrincipalId: 'arthur' });
    assert.throws(() => buildRunRecord(supplied), /Run ownership cannot be supplied/);
    // Without a live request nothing delegates.
    assert.throws(() => resolveStaticReviewOwner(), /arthur is a replacement identity/);
    assert.deepEqual(resolveStaticReviewOwner({ ownerId: 'farm-automation' }), {
      ownerId: 'farm-automation',
      requester: { principalId: 'arthur', principalGeneration: 1 },
    });
  });
  runWithSessionOriginator(observer, () => {
    assert.throws(() => resolveStaticReviewOwner('live'), /owned execution node/);
    assert.throws(
      () => resolveStaticReviewOwner({ ownerId: 'farm-automation' }),
      /remain an admin person/,
    );
  });
  // A caller whose own resolution succeeds keeps its ownership.
  runWithSessionOriginator(nodeOwner, () =>
    assert.deepEqual(resolveStaticReviewOwner('live'), { ownerId: nodeOwner.id }),
  );
  delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  runWithSessionOriginator(arthur, () =>
    assert.throws(() => resolveStaticReviewOwner('live'), /arthur is a replacement identity/),
  );
});

test('a queued delegated request fires only while its requester is still that admin', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'delegated-requester-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const auth = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  const admin = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  const keeper = auth.writer.createPrincipal({ type: 'service', displayName: 'Keeper' }, admin);
  auth.writer.issueCredential(keeper.id, 'keeper');
  const person = { type: 'person' as const, displayName: 'Arthur' };
  auth.writer.createPrincipal(person, admin, 'arthur');
  auth.writer.retirePrincipals(['arthur']);
  auth.writer.createPrincipal(person, admin, 'arthur', { reuseRetiredId: true });
  const requester = { kind: 'principal' as const, principalId: 'arthur', principalGeneration: 1 };
  const fire = () =>
    authorizeStoredRunEffect(
      resolveWorkOriginator(auth, requester),
      'delegated review',
      undefined,
      replacedWorkOriginator(auth, requester),
    );
  assert.equal(fire().id, 'arthur');
  auth.writer.revokeRole('arthur', 'admin', { kind: 'global' });
  assert.throws(fire, /no longer has admin\/global authority/);
  auth.writer.retirePrincipals(['arthur']);
  auth.writer.createPrincipal(person, admin, 'arthur', { reuseRetiredId: true });
  assert.throws(fire, /arthur has been replaced by a newer identity/);
});
