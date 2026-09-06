import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityLifecycleEvent,
  RuntimeCapabilityProviderActionRef,
} from '@farmslot/protocol';

import { runtimeCapabilityProviderDigest, RuntimeCapabilityRegistry } from './registry.js';
import { RuntimeCapabilityStore } from './store.js';

const SLOT = 'slot-a';

function holdsProviderForTest(lease: { state: string }): boolean {
  return ['acquiring', 'acquired', 'releasing'].includes(lease.state);
}

function entry(
  id: string,
  sharePolicy: RuntimeCapabilityCatalogEntry['sharePolicy'] = 'exclusive',
  dependencies: string[] = [],
): RuntimeCapabilityCatalogEntry {
  const action = (name: string): RuntimeCapabilityProviderActionRef => ({
    kind: 'slot-action',
    actionId: `${id}.${name}`,
  });
  return {
    id,
    project: 'test-project',
    label: id,
    version: '1',
    dependencies,
    sharePolicy,
    cost: { class: 'low', resources: [] },
    actions: {
      acquire: action('acquire'),
      health: action('health'),
      release: action('release'),
    },
    releaseEffects: [`release ${id}`],
    provenance: {
      project: 'test-project',
      providerId: id,
      version: '1',
      digest: `digest-${id}`,
    },
    availability: { state: 'available' },
  };
}

async function fixture(
  t: TestContext,
  capabilities: RuntimeCapabilityCatalogEntry[],
  options: {
    pressureFor?: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['pressureFor'];
    familyForRun?: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['familyForRun'];
    runAction?: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['runAction'];
    onEvent?: (event: RuntimeCapabilityLifecycleEvent) => void;
    storeFactory?: (storePath: string) => RuntimeCapabilityStore;
    isTerminalOwner?: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['isTerminalOwner'];
    now?: () => Date;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actions: string[] = [];
  let nextLease = 0;
  const storePath = path.join(directory, 'leases.json');
  const store = options.storeFactory?.(storePath) ?? new RuntimeCapabilityStore(storePath);
  const registry = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({ slotId, project: 'test-project', capabilities }),
    runAction: async (_slotId, action) => {
      actions.push(
        action.kind === 'slot-action' ? action.actionId : `${action.resourceId}.${action.action}`,
      );
      return options.runAction ? options.runAction(_slotId, action) : { ok: true };
    },
    ...(options.pressureFor ? { pressureFor: options.pressureFor } : {}),
    ...(options.familyForRun ? { familyForRun: options.familyForRun } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.isTerminalOwner ? { isTerminalOwner: options.isTerminalOwner } : {}),
    leaseId: () => `lease-${++nextLease}`,
    now: options.now ?? (() => new Date('2026-08-11T00:00:00.000Z')),
  });
  return { registry, actions, store, storePath };
}

function acquire(
  registry: RuntimeCapabilityRegistry,
  capabilityId: string,
  ownerRunId: string,
  ownerFamilyId?: string,
) {
  return registry.acquire({
    slotId: SLOT,
    capabilityId,
    ownerRunId,
    ...(ownerFamilyId ? { ownerFamilyId } : {}),
    proofRequirement: {
      capabilityId,
      reason: `prove ${capabilityId}`,
      mode: 'state',
    },
  });
}

test('acquire is idempotent and exclusive conflicts expose owner and reason', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser')]);
  const first = await acquire(registry, 'browser', 'run-a');
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const repeated = await acquire(registry, 'browser', 'run-a');
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.lease.id, first.lease.id);
  assert.equal(actions.filter((action) => action === 'browser.acquire').length, 1);

  const conflict = await acquire(registry, 'browser', 'run-b');
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.conflict.kind, 'lease-conflict');
  if (conflict.conflict.kind !== 'lease-conflict') return;
  assert.equal(conflict.conflict.owner.runId, 'run-a');
  assert.match(conflict.conflict.reason, /owned by run-a/);
});

test('acquire validates typed parameters before running provider actions', async (t) => {
  const parameterized = {
    ...entry('browser'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['viewport'],
      properties: { viewport: { type: 'string', enum: ['desktop', 'mobile'] } },
    },
  };
  const { registry, actions } = await fixture(t, [parameterized]);

  const invalid = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    parameters: { viewport: 'television' },
    proofRequirement: {
      capabilityId: 'browser',
      reason: 'visual proof',
      mode: 'visual',
    },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.conflict.kind, 'invalid-request');
  assert.equal(actions.length, 0);

  const valid = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    parameters: { viewport: 'desktop' },
    proofRequirement: {
      capabilityId: 'browser',
      reason: 'visual proof',
      mode: 'visual',
    },
  });
  assert.equal(valid.ok, true);
});

test('exclusive resource claims conflict across different capability ids', async (t) => {
  const first = {
    ...entry('browser-a'),
    cost: {
      class: 'high' as const,
      resources: [{ id: 'cdp-port', access: 'exclusive' as const, kind: 'port' as const }],
    },
  };
  const second = {
    ...entry('browser-b'),
    cost: {
      class: 'high' as const,
      resources: [{ id: 'cdp-port', access: 'shared' as const, kind: 'port' as const }],
    },
  };
  const { registry } = await fixture(t, [first, second]);
  await acquire(registry, 'browser-a', 'run-a');

  const result = await acquire(registry, 'browser-b', 'run-b');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.conflict.kind, 'lease-conflict');
  assert.match(result.conflict.reason, /Resource 'cdp-port'.*browser-a.*run-a/);
});

test('shared providers reference-count holders and release only after the final lease', async (t) => {
  const { registry, actions } = await fixture(t, [entry('gateway', 'shared')]);
  const first = await acquire(registry, 'gateway', 'run-a');
  const second = await acquire(registry, 'gateway', 'run-b');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(actions.filter((action) => action === 'gateway.acquire').length, 1);

  const status = await registry.status({ slotId: SLOT });
  assert.deepEqual(
    status.leases
      .filter((lease) => lease.state === 'acquired')
      .map((lease) => lease.referenceCount),
    [2, 2],
  );

  const sharedRelease = await registry.release({
    slotId: SLOT,
    ownerRunId: 'run-a',
    leaseId: first.lease.id,
  });
  assert.deepEqual(sharedRelease.effects, []);
  assert.equal(actions.includes('gateway.release'), false);
  const retained = await registry.status({ slotId: SLOT, ownerRunId: 'run-b' });
  assert.equal(retained.leases.find((lease) => lease.id === second.lease.id)?.referenceCount, 1);

  await registry.release({ slotId: SLOT, ownerRunId: 'run-b', leaseId: second.lease.id });
  assert.equal(actions.filter((action) => action === 'gateway.release').length, 1);
});

test('family cleanup releases every sibling lease while slot cleanup includes orphan owners', async (t) => {
  const { registry, actions } = await fixture(t, [entry('gateway', 'shared')]);
  assert.equal((await acquire(registry, 'gateway', 'run-a', 'family-a')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'run-b', 'family-a')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'run-c', 'family-b')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'orphan-run')).ok, true);
  actions.length = 0;

  const familyRelease = await registry.releaseFamily(SLOT, 'family-a');
  assert.equal(familyRelease.ok, true);
  assert.deepEqual(
    familyRelease.released.map((lease) => lease.owner.runId),
    ['run-a', 'run-b'],
  );
  assert.equal(actions.includes('gateway.release'), false);

  const activeAfterFamily = (await registry.status({ slotId: SLOT })).leases.filter(
    (lease) => lease.state === 'acquired',
  );
  assert.deepEqual(
    activeAfterFamily.map((lease) => lease.owner.runId),
    ['run-c', 'orphan-run'],
  );

  const slotRelease = await registry.releaseSlot(SLOT);
  assert.equal(slotRelease.ok, true);
  assert.deepEqual(
    slotRelease.released.map((lease) => lease.owner.runId),
    ['run-c', 'orphan-run'],
  );
  assert.equal(actions.filter((action) => action === 'gateway.release').length, 1);
});

test('run and family cleanup includes a familyless current-run lease and explicit family owners', async (t) => {
  const { registry } = await fixture(t, [entry('gateway', 'shared')]);
  assert.equal((await acquire(registry, 'gateway', 'current-run')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'current-family-run', 'family-a')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'sibling-run', 'family-a')).ok, true);
  assert.equal((await acquire(registry, 'gateway', 'unrelated-run', 'family-b')).ok, true);

  const result = await registry.releaseRunAndFamily(SLOT, 'current-run', 'family-a');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.released.map((lease) => lease.owner.runId),
    ['current-run', 'current-family-run', 'sibling-run'],
  );
  assert.deepEqual(
    (await registry.status({ slotId: SLOT })).leases
      .filter((lease) => lease.state === 'acquired')
      .map((lease) => lease.owner.runId),
    ['unrelated-run'],
  );
});

test('release orders owning capabilities before dependencies even when all owner leases are roots', async (t) => {
  const { registry, actions } = await fixture(t, [
    entry('dependency', 'shared'),
    entry('parent', 'exclusive', ['dependency']),
  ]);
  const acquired = await acquire(registry, 'parent', 'run-a');
  assert.equal(acquired.ok, true);
  actions.length = 0;

  const retainedDependency = await registry.release({
    slotId: SLOT,
    ownerRunId: 'run-a',
    capabilityId: 'dependency',
  });
  assert.deepEqual(retainedDependency.effects, []);
  assert.deepEqual(
    retainedDependency.retained.map((lease) => lease.capabilityId),
    ['dependency'],
  );

  const released = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(released.ok, true);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['parent.release', 'dependency.release'],
  );
  assert.deepEqual(
    released.released.map((lease) => lease.capabilityId),
    ['parent', 'dependency'],
  );
});

test('release orders every selected parent before their shared dependency', async (t) => {
  const { registry, actions } = await fixture(t, [
    entry('dependency', 'shared'),
    entry('parent-a', 'exclusive', ['dependency']),
    entry('parent-b', 'exclusive', ['dependency']),
  ]);
  assert.equal((await acquire(registry, 'parent-a', 'run-a')).ok, true);
  assert.equal((await acquire(registry, 'parent-b', 'run-a')).ok, true);
  actions.length = 0;

  const released = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(released.ok, true);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['parent-a.release', 'parent-b.release', 'dependency.release'],
  );
  assert.deepEqual(
    released.released.map((lease) => lease.capabilityId),
    ['parent-a', 'parent-b', 'dependency'],
  );
});

test('lifecycle events publish only after acquired and released snapshots are durable', async (t) => {
  class DelayedStore extends RuntimeCapabilityStore {
    override async replace(snapshot: Parameters<RuntimeCapabilityStore['replace']>[0]) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await super.replace(snapshot);
    }
  }

  let registry!: RuntimeCapabilityRegistry;
  const observedStates: Array<Promise<{ kind: string; state: string | undefined }>> = [];
  const result = await fixture(t, [entry('browser')], {
    storeFactory: (storePath) => new DelayedStore(storePath),
    onEvent: (event) => {
      if (event.kind !== 'acquired' && event.kind !== 'released') return;
      observedStates.push(
        registry.status({ slotId: SLOT }).then((status) => ({
          kind: event.kind,
          state: status.leases.find((lease) => lease.id === event.leaseId)?.state,
        })),
      );
    },
  });
  registry = result.registry;

  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  assert.equal((await registry.release({ slotId: SLOT, ownerRunId: 'run-a' })).ok, true);
  assert.deepEqual(await Promise.all(observedStates), [
    { kind: 'acquired', state: 'acquired' },
    { kind: 'released', state: 'released' },
  ]);
});

test('failed parent acquire rolls back the provider and newly acquired dependencies', async (t) => {
  const { registry, actions } = await fixture(
    t,
    [entry('dependency', 'shared'), entry('parent', 'exclusive', ['dependency'])],
    {
      runAction: async (_slot, action) => ({
        ok: !(action.kind === 'slot-action' && action.actionId === 'parent.acquire'),
        detail:
          action.kind === 'slot-action' && action.actionId === 'parent.acquire'
            ? 'parent start failed'
            : undefined,
      }),
    },
  );

  const result = await acquire(registry, 'parent', 'run-a');
  assert.equal(result.ok, false);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['parent.release', 'dependency.release'],
  );
  assert.deepEqual(
    (await registry.status({ slotId: SLOT })).leases.map((lease) => lease.state),
    ['released', 'released'],
  );
});

test('failed parent health rolls back the provider and newly acquired dependencies', async (t) => {
  const { registry, actions } = await fixture(
    t,
    [entry('dependency', 'shared'), entry('parent', 'exclusive', ['dependency'])],
    {
      runAction: async (_slot, action) => ({
        ok: !(action.kind === 'slot-action' && action.actionId === 'parent.health'),
        detail:
          action.kind === 'slot-action' && action.actionId === 'parent.health'
            ? 'parent is unhealthy'
            : undefined,
      }),
    },
  );

  const result = await acquire(registry, 'parent', 'run-a');
  assert.equal(result.ok, false);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['parent.release', 'dependency.release'],
  );
  assert.deepEqual(
    (await registry.status({ slotId: SLOT })).leases.map((lease) => lease.state),
    ['released', 'released'],
  );
});

test('a thrown provider action records cleanup failure without claiming release', async (t) => {
  const { registry } = await fixture(t, [entry('browser')], {
    runAction: async (_slot, action) => {
      if (action.kind !== 'slot-action') return { ok: true };
      if (action.actionId === 'browser.acquire') throw new Error('spawn exploded');
      if (action.actionId === 'browser.release') return { ok: false, detail: 'stop refused' };
      return { ok: true };
    },
  });

  const result = await acquire(registry, 'browser', 'run-a');
  assert.equal(result.ok, false);
  const status = await registry.status({ slotId: SLOT });
  assert.equal(status.leases[0]?.state, 'error');
  assert.equal(status.leases[0]?.cleanupFailure, 'stop refused');
  assert(status.events.some((event) => event.kind === 'cleanup-failed'));
  assert.equal(
    status.events.some((event) => event.kind === 'released'),
    false,
  );
});

test('unresolved cleanup blocks acquisition and can be retried by the lease owner', async (t) => {
  let releaseFails = true;
  const { registry } = await fixture(t, [entry('browser')], {
    runAction: async (_slot, action) => {
      if (action.kind !== 'slot-action') return { ok: true };
      if (action.actionId === 'browser.release' && releaseFails) {
        return { ok: false, detail: 'profile still locked' };
      }
      return { ok: true };
    },
  });
  const acquired = await acquire(registry, 'browser', 'run-a');
  assert.equal(acquired.ok, true);
  const failedRelease = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(failedRelease.ok, false);
  assert.deepEqual(failedRelease.effects, []);

  const blocked = await acquire(registry, 'browser', 'run-b');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.conflict.kind, 'lease-conflict');
    assert.match(blocked.conflict.reason, /unresolved cleanup.*profile still locked/);
  }

  releaseFails = false;
  const retried = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.effects, ['release browser']);
  assert.equal(retried.released[0]?.state, 'released');
  assert.equal((await acquire(registry, 'browser', 'run-b')).ok, true);
});

test('a queued pressure rejection retries the same lease without cancelling another owner', async (t) => {
  let pressured = true;
  const { registry, actions } = await fixture(
    t,
    [entry('dependency', 'shared'), entry('browser', 'exclusive', ['dependency'])],
    {
      pressureFor: async () =>
        pressured
          ? {
              kind: 'host-pressure',
              severity: 'critical',
              reason: 'memory pressure',
              queued: true,
            }
          : null,
    },
  );
  const queued = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    parameters: { attempt: 'queued' },
    queueOnPressure: true,
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(queued.ok, false);
  const queuedStatus = await registry.status({ slotId: SLOT });
  assert.equal(queuedStatus.leases[0]?.state, 'queued');
  assert.deepEqual(queuedStatus.pressure, {
    kind: 'host-pressure',
    severity: 'critical',
    reason: 'memory pressure',
    queued: true,
  });
  assert.equal(actions.length, 0);

  pressured = false;
  const retried = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    parameters: { attempt: 'retried' },
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(retried.lease.id, 'lease-1');
  assert.equal(retried.lease.state, 'acquired');
  assert.deepEqual(retried.lease.parameters, { attempt: 'retried' });
  assert.deepEqual(retried.lease.dependencyLeaseIds, ['lease-2']);
  assert.equal((await registry.status({ slotId: SLOT })).pressure, undefined);
  assert.equal(actions.filter((action) => action === 'browser.acquire').length, 1);

  actions.length = 0;
  const released = await registry.release({
    slotId: SLOT,
    ownerRunId: 'run-a',
    capabilityId: 'browser',
    leaseId: retried.lease.id,
  });
  assert.equal(released.ok, true);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['browser.release', 'dependency.release'],
  );
  assert.deepEqual(
    released.released.map((lease) => lease.capabilityId),
    ['browser', 'dependency'],
  );
});

test('force release retries cleanup with the current provider after provenance changes', async (t) => {
  const browser = entry('browser');
  const { registry, actions } = await fixture(t, [browser]);
  await acquire(registry, 'browser', 'run-a');
  browser.provenance.digest = 'digest-browser-v2';

  const refused = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0]?.reason ?? '', /provenance changed/);
  assert.equal(actions.includes('browser.release'), false);

  const forced = await registry.release({ slotId: SLOT, ownerRunId: 'run-a', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.released[0]?.state, 'released');
  assert.equal(actions.filter((action) => action === 'browser.release').length, 1);
});

test('an errored shared sibling does not suppress final provider release', async (t) => {
  const gateway = entry('gateway', 'shared');
  const originalDigest = gateway.provenance.digest;
  const { registry, actions } = await fixture(t, [gateway]);
  await acquire(registry, 'gateway', 'run-a');
  await acquire(registry, 'gateway', 'run-b');

  gateway.provenance.digest = 'digest-gateway-v2';
  const failed = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(failed.ok, false);
  gateway.provenance.digest = originalDigest;

  const released = await registry.release({ slotId: SLOT, ownerRunId: 'run-b' });
  assert.equal(released.ok, true);
  assert.deepEqual(released.effects, ['release gateway']);
  assert.equal(actions.filter((action) => action === 'gateway.release').length, 1);
});

test('a queued sibling does not suppress provider release by the acquired holder', async (t) => {
  let pressured = false;
  const { registry, actions } = await fixture(t, [entry('browser')], {
    pressureFor: async () =>
      pressured
        ? {
            kind: 'host-pressure',
            severity: 'critical',
            reason: 'memory pressure',
            queued: true,
          }
        : null,
  });
  await acquire(registry, 'browser', 'run-a');
  pressured = true;
  const queued = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-b',
    queueOnPressure: true,
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(queued.ok, false);

  const released = await registry.release({
    slotId: SLOT,
    ownerRunId: 'run-a',
  });
  assert.equal(released.ok, true);
  assert.deepEqual(released.effects, ['release browser']);
  assert.equal(actions.filter((action) => action === 'browser.release').length, 1);
});

test('a queued sibling does not suppress provider release during acquisition rollback', async (t) => {
  let pressured = true;
  const { registry, actions } = await fixture(t, [entry('browser', 'shared')], {
    pressureFor: async () =>
      pressured
        ? {
            kind: 'host-pressure',
            severity: 'critical',
            reason: 'memory pressure',
            queued: true,
          }
        : null,
    runAction: async (_slot, action) => ({
      ok: !(action.kind === 'slot-action' && action.actionId === 'browser.acquire'),
      detail:
        action.kind === 'slot-action' && action.actionId === 'browser.acquire'
          ? 'browser start failed'
          : undefined,
    }),
  });
  const queued = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    queueOnPressure: true,
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(queued.ok, false);
  pressured = false;

  const failed = await acquire(registry, 'browser', 'run-b');
  assert.equal(failed.ok, false);
  assert.equal(actions.filter((action) => action === 'browser.release').length, 1);
});

test('releasing a queued lease does not keep an unstarted provider warm', async (t) => {
  const warmBrowser = { ...entry('browser'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warmBrowser], {
    pressureFor: async () => ({
      kind: 'host-pressure',
      severity: 'critical',
      reason: 'memory pressure',
      queued: true,
    }),
  });
  const queued = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    queueOnPressure: true,
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(queued.ok, false);

  const released = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.equal(released.ok, true);
  assert.deepEqual(released.effects, []);
  assert.equal(released.released[0]?.keepWarmUntil, undefined);
  assert.equal(actions.length, 0);
});

test('keep-warm release has an explicit deadline and cleanup runs once after expiry', async (t) => {
  let nowMs = Date.parse('2026-08-11T00:00:00.000Z');
  const warmBrowser = { ...entry('browser'), keepWarmMs: 1_000 };
  const { registry, actions } = await fixture(t, [warmBrowser], {
    now: () => new Date(nowMs),
  });
  await acquire(registry, 'browser', 'run-a');
  const warmRelease = await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  assert.deepEqual(warmRelease.effects, []);
  assert.equal(actions.filter((action) => action === 'browser.release').length, 0);
  assert.equal(
    (await registry.status({ slotId: SLOT })).leases[0]?.keepWarmUntil,
    '2026-08-11T00:00:01.000Z',
  );

  nowMs += 1_001;
  await registry.cleanupExpiredWarmProviders();
  await registry.cleanupExpiredWarmProviders();
  assert.equal(actions.filter((action) => action === 'browser.release').length, 1);
});

test('a queued sibling does not suppress expired keep-warm provider cleanup', async (t) => {
  let nowMs = Date.parse('2026-08-11T00:00:00.000Z');
  let pressured = false;
  const warmBrowser = { ...entry('browser'), keepWarmMs: 1_000 };
  const { registry, actions } = await fixture(t, [warmBrowser], {
    now: () => new Date(nowMs),
    pressureFor: async () =>
      pressured
        ? {
            kind: 'host-pressure',
            severity: 'critical',
            reason: 'memory pressure',
            queued: true,
          }
        : null,
  });
  await acquire(registry, 'browser', 'run-a');
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  pressured = true;
  const queued = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-b',
    queueOnPressure: true,
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(queued.ok, false);

  nowMs += 1_001;
  await registry.cleanupExpiredWarmProviders();
  assert.equal(actions.filter((action) => action === 'browser.release').length, 1);
});

test('revalidateHealth cleans up a dead retained provider and reacquires it', async (t) => {
  let healthy = true;
  const { registry, actions } = await fixture(t, [entry('browser')], {
    runAction: async (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'browser.health' && !healthy
        ? { ok: false, detail: 'browser is not responding' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);

  // The provider dies while the run waits, then validation prepares.
  healthy = false;
  actions.length = 0;
  const stale = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'browser', reason: 'validation', mode: 'visual' },
    revalidateHealth: true,
  });
  // Health failed, so the retained provider was released before anything reused it.
  assert.ok(actions.includes('browser.release'), actions.join(', '));
  assert.equal(stale.ok, false);

  // Once the provider is healthy again the same request acquires it fresh.
  healthy = true;
  actions.length = 0;
  const fresh = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'browser', reason: 'validation', mode: 'visual' },
    revalidateHealth: true,
  });
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(fresh.idempotent, false, 'a cleaned-up lease must not be reused as idempotent');
  assert.ok(actions.includes('browser.acquire'));
});

test('revalidateHealth reuses a retained provider that is still healthy', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  actions.length = 0;
  const again = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'browser', reason: 'validation', mode: 'visual' },
    revalidateHealth: true,
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.idempotent, true);
  // Proof that health really ran, and that nothing was torn down.
  assert.deepEqual(actions, ['browser.health']);
});

test('acquire without revalidateHealth keeps the cheap idempotent path', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  actions.length = 0;
  const again = await acquire(registry, 'browser', 'run-a');
  assert.equal(again.ok, true);
  assert.deepEqual(actions, [], 'worker acquires must not pay for an extra health check');
});

test('stopWarmProviders ends a keep-warm window before its deadline', async (t) => {
  const warm = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warm]);
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });
  // Released but still warm: no release action ran.
  assert.ok(!actions.includes('metro.release'));

  actions.length = 0;
  await registry.stopWarmProviders(SLOT, ['metro']);
  assert.deepEqual(actions, ['metro.release']);
  const status = await registry.status({ slotId: SLOT });
  assert.equal(
    status.leases.every((lease) => lease.keepWarmUntil === undefined),
    true,
  );
});

test('stopWarmProviders ends warm windows in dependency order', async (t) => {
  const warmApp = { ...entry('app', 'exclusive', ['metro']), keepWarmMs: 600_000 };
  const warmMetro = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warmApp, warmMetro]);
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });

  actions.length = 0;
  await registry.stopWarmProviders(SLOT);
  const releases = actions.filter((action) => action.endsWith('.release'));
  // The dependency was created first, so insertion order would stop metro out
  // from under app.
  assert.deepEqual(releases, ['app.release', 'metro.release']);
});

test('revalidateHealth on a healthy parent still proves its dependencies', async (t) => {
  let metroHealthy = true;
  const { registry, actions } = await fixture(
    t,
    [entry('app', 'exclusive', ['metro']), entry('metro')],
    {
      runAction: async (_slotId, action) =>
        action.kind === 'slot-action' && action.actionId === 'metro.health' && !metroHealthy
          ? { ok: false, detail: 'metro is not responding' }
          : { ok: true },
    },
  );
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);

  // The parent is still fine; the thing it runs on died.
  metroHealthy = false;
  actions.length = 0;
  const blocked = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'app',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'app', reason: 'validation', mode: 'state' },
    revalidateHealth: true,
  });
  assert.equal(blocked.ok, false, 'a dead dependency must not pass preparation');
  assert.ok(actions.includes('metro.health'), actions.join(', '));
  assert.ok(actions.includes('metro.release'), actions.join(', '));

  metroHealthy = true;
  const recovered = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'app',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'app', reason: 'validation', mode: 'state' },
    revalidateHealth: true,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.ok(
    recovered.dependencyLeases.some((lease) => lease.capabilityId === 'metro'),
    'the revalidated dependency is reported back to the caller',
  );
});

test('releaseForPosture honors each lease disposition and leaves a retained dependency alone', async (t) => {
  const { registry, actions } = await fixture(t, [
    entry('app', 'exclusive', ['metro']),
    entry('metro'),
  ]);
  const acquired = await acquire(registry, 'app', 'run-a');
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  const metroLease = acquired.dependencyLeases.find((lease) => lease.capabilityId === 'metro')!;
  assert.ok(metroLease);
  actions.length = 0;

  // Policy: stop the parent, keep the dependency acquired.
  const result = await registry.releaseForPosture(SLOT, [
    { leaseId: acquired.lease.id, keepWarm: false },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['app.release'],
    'the dependency must not be released because its parent was',
  );
  const status = await registry.status({ slotId: SLOT });
  const metro = status.leases.find((lease) => lease.id === metroLease.id);
  assert.equal(metro?.state, 'acquired', 'a dependency the policy retains stays acquired');
});

test('a revalidated replacement dependency is relinked so a parent release cannot leak it', async (t) => {
  let metroHealthy = true;
  const { registry, actions } = await fixture(
    t,
    [entry('app', 'exclusive', ['metro']), entry('metro')],
    {
      runAction: async (_slotId, action) =>
        action.kind === 'slot-action' && action.actionId === 'metro.health' && !metroHealthy
          ? { ok: false, detail: 'metro is not responding' }
          : { ok: true },
    },
  );
  const first = await acquire(registry, 'app', 'run-a');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const originalMetro = first.dependencyLeases.find((lease) => lease.capabilityId === 'metro')!;

  // The dependency dies and is replaced under a still-healthy parent.
  metroHealthy = false;
  const blocked = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'app',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'app', reason: 'validation', mode: 'state' },
    revalidateHealth: true,
  });
  assert.equal(blocked.ok, false);
  metroHealthy = true;
  const recovered = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'app',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'app', reason: 'validation', mode: 'state' },
    revalidateHealth: true,
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  const replacement = recovered.dependencyLeases.find((lease) => lease.capabilityId === 'metro')!;
  assert.notEqual(replacement.id, originalMetro.id, 'the dependency really was replaced');

  actions.length = 0;
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'app' });
  const status = await registry.status({ slotId: SLOT });
  const leaked = status.leases.filter(
    (lease) => lease.capabilityId === 'metro' && holdsProviderForTest(lease),
  );
  assert.deepEqual(leaked, [], 'the replacement dependency must not survive the parent release');
  assert.ok(actions.includes('metro.release'), actions.join(', '));
});

test('a warm sweep defers a dependency while its dependent is still warm', async (t) => {
  let clock = new Date('2026-08-11T00:00:00.000Z');
  const warmApp = { ...entry('app', 'exclusive', ['metro']), keepWarmMs: 600_000 };
  const warmMetro = { ...entry('metro'), keepWarmMs: 60_000 };
  const { registry, actions } = await fixture(t, [warmApp, warmMetro], { now: () => clock });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });

  // The dependency's shorter window expires first.
  clock = new Date('2026-08-11T00:05:00.000Z');
  actions.length = 0;
  await registry.cleanupExpiredWarmProviders([SLOT]);
  assert.deepEqual([...actions], [], 'metro is still holding up a warm app');

  // Once the dependent's window ends, both go, dependent first.
  clock = new Date('2026-08-11T00:20:00.000Z');
  actions.length = 0;
  await registry.cleanupExpiredWarmProviders([SLOT]);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['app.release', 'metro.release'],
  );
});

test('terminal cleanup releases a lease that only reaches acquired after it started', async (t) => {
  // Reproduces the live incident: an acquire was in flight when a cancelled run
  // ran terminal cleanup, and the leases that completed afterwards stayed
  // acquired, holding a simulator and Metro for a run that no longer existed.
  let releaseSlowAcquire = (): void => {};
  const slowAcquire = new Promise<void>((resolve) => {
    releaseSlowAcquire = resolve;
  });
  let gateArmed = true;
  const { registry, actions } = await fixture(
    t,
    [entry('ios-simulator', 'exclusive', ['companion-metro']), entry('companion-metro')],
    {
      runAction: async (_slotId, action) => {
        if (
          gateArmed &&
          action.kind === 'slot-action' &&
          action.actionId === 'ios-simulator.acquire'
        ) {
          gateArmed = false;
          await slowAcquire;
        }
        return { ok: true };
      },
    },
  );

  const acquiring = acquire(registry, 'ios-simulator', 'run-a', 'fam-a');
  // Let the acquire reach its slow provider action.
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Terminal cleanup starts while the acquire is still running.
  const terminal = registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  releaseSlowAcquire();
  const [acquired, result] = await Promise.all([acquiring, terminal]);
  assert.equal(acquired.ok, true);
  assert.equal(result.ok, true);

  const status = await registry.status({ slotId: SLOT });
  const stillHeld = status.leases.filter((lease) => holdsProviderForTest(lease));
  assert.deepEqual(stillHeld, [], 'no lease may survive its run terminal cleanup');
  assert.ok(actions.includes('ios-simulator.release'), actions.join(', '));
  assert.ok(actions.includes('companion-metro.release'), actions.join(', '));
});

test('a run that already had terminal cleanup cannot acquire again', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  actions.length = 0;

  const late = await acquire(registry, 'browser', 'run-a');
  assert.equal(late.ok, false, 'a terminal run must not be handed a provider');
  if (late.ok) return;
  assert.match(late.conflict.reason, /terminal capability cleanup/);
  assert.deepEqual(actions, [], 'nothing may be booted for a terminal run');
  const status = await registry.status({ slotId: SLOT });
  assert.deepEqual(
    status.leases.filter((lease) => holdsProviderForTest(lease)),
    [],
  );

  // Another run is unaffected by the fence.
  const other = await acquire(registry, 'browser', 'run-b');
  assert.equal(other.ok, true);
});

test('the terminal fence survives a gateway restart over the same store', async (t) => {
  const { registry, store } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');

  // A brand new registry over the SAME durable store — the restart. Its own
  // sets start empty, so anything it refuses it refuses from the store.
  const restarted = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(store.path),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [entry('browser')],
    }),
    runAction: async () => ({ ok: true }),
    leaseId: () => 'lease-after-restart',
  });

  const late = await acquire(restarted, 'browser', 'run-a');
  assert.equal(late.ok, false, 'a restart must not lift the terminal fence');
  if (late.ok) return;
  assert.match(late.conflict.reason, /terminal capability cleanup/);

  // The family half survives too, so a sibling cannot reacquire on the way out.
  const sibling = await acquire(restarted, 'browser', 'run-sibling', 'fam-a');
  assert.equal(sibling.ok, false);

  // A run in neither fence is still served.
  assert.equal((await acquire(restarted, 'browser', 'run-unrelated')).ok, true);
});

test('an owner evicted past the fence bound is still refused through the run store', async (t) => {
  const terminalRuns = new Set<string>();
  const { registry, store } = await fixture(t, [entry('browser')], {
    isTerminalOwner: (ownerRunId) => terminalRuns.has(ownerRunId),
  });
  assert.equal((await acquire(registry, 'browser', 'run-a')).ok, true);
  terminalRuns.add('run-a');
  await registry.releaseRunTerminal(SLOT, 'run-a');

  // Evict it the way churn past the bound would: the durable list no longer
  // names this owner, so only the run-store predicate can still refuse it.
  const snapshot = store.snapshot();
  snapshot.terminalOwners = [];
  await store.replace(snapshot);
  const restarted = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(store.path),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [entry('browser')],
    }),
    runAction: async () => ({ ok: true }),
    isTerminalOwner: (ownerRunId) => terminalRuns.has(ownerRunId),
    leaseId: () => 'lease-after-eviction',
  });

  const late = await acquire(restarted, 'browser', 'run-a');
  assert.equal(late.ok, false, 'eviction must fall through to the run store, not open the fence');
  if (late.ok) return;
  assert.match(late.conflict.reason, /terminal capability cleanup/);

  // The predicate fences only the terminal run; its non-terminal sibling runs.
  assert.equal((await acquire(restarted, 'browser', 'run-b')).ok, true);
});

test('a live child of a terminal family is NOT fenced by its parent finishing', async (t) => {
  // The regression an "is any member terminal" predicate caused. A CI-watch
  // chain's follow-up run shares its parent's family, so the parent reaching
  // `done` refused its own live child at PREPARE. Only an actual family-scope
  // cleanup may fence a family.
  const { registry } = await fixture(t, [entry('browser')], {
    familyForRun: () => 'fam-a',
    // The parent is terminal in the run store; the child is not.
    isTerminalOwner: (ownerRunId) => ownerRunId === 'run-parent',
  });

  const child = await acquire(registry, 'browser', 'run-child', 'fam-a');
  assert.equal(child.ok, true, 'a live chained child must still acquire');
});

test('a family-scope cleanup fences the family, and survives eviction and restart', async (t) => {
  const { registry, store } = await fixture(t, [entry('browser')], {
    familyForRun: (ownerRunId) => (ownerRunId === 'run-outsider' ? 'fam-b' : 'fam-a'),
  });
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');

  // A brand new registry over the same store, with NO run-store predicates at
  // all: whatever it refuses, it refuses from the durable entries alone.
  const restarted = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(store.path),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [entry('browser')],
    }),
    runAction: async () => ({ ok: true }),
    familyForRun: (ownerRunId) => (ownerRunId === 'run-outsider' ? 'fam-b' : 'fam-a'),
    leaseId: () => 'lease-sibling',
  });

  const sibling = await acquire(restarted, 'browser', 'run-sibling', 'fam-a');
  assert.equal(sibling.ok, false, 'the family cleanup fences the family');
  if (sibling.ok) return;
  // The refusal says what is actually true: the FAMILY was cleaned, not this run.
  assert.match(sibling.conflict.reason, /Family 'fam-a' has already had its terminal/);
  assert.doesNotMatch(sibling.conflict.reason, /Run 'run-sibling' has already had/);

  // A run in another family is untouched.
  assert.equal((await acquire(restarted, 'browser', 'run-outsider', 'fam-b')).ok, true);
});

test('an archived terminal owner is still refused, with no live record to read', async (t) => {
  // Archiving deletes the run record, so every live-record fallback goes blind.
  // The durable entries are what keep authority, and they retire by age rather
  // than by count so the oldest owners — the ones archiving has already
  // removed — are exactly the ones still covered.
  const { registry, store } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-archived')).ok, true);
  await registry.releaseRunTerminal(SLOT, 'run-archived');

  const restarted = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(store.path),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [entry('browser')],
    }),
    runAction: async () => ({ ok: true }),
    // The run is archived: the store cannot answer for it at all.
    isTerminalOwner: () => false,
    leaseId: () => 'lease-archived',
  });

  const late = await acquire(restarted, 'browser', 'run-archived');
  assert.equal(late.ok, false, 'an archived terminal owner must not reacquire');
  if (late.ok) return;
  assert.match(late.conflict.reason, /terminal capability cleanup/);
});

test('a queued lease of a fenced owner is dropped instead of blocking the capability', async (t) => {
  const { registry, store, actions } = await fixture(t, [entry('browser')]);
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  // A second owner queues behind the exclusive holder, then the holder's family
  // goes terminal — the queue slot outlives the run that wanted it.
  const snapshot = store.snapshot();
  snapshot.leases.push({
    ...structuredClone(snapshot.leases[0]!),
    id: 'lease-queued',
    state: 'queued',
    owner: { runId: 'run-a', familyId: 'fam-a' },
  });
  snapshot.terminalOwners = ['run-a'];
  snapshot.terminalFamilies = ['fam-a'];
  await store.replace(snapshot);
  actions.length = 0;

  const restarted = new RuntimeCapabilityRegistry({
    store: new RuntimeCapabilityStore(store.path),
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [entry('browser')],
    }),
    runAction: async () => ({ ok: true }),
    leaseId: () => 'lease-after-queue',
  });
  await restarted.recover();

  const status = await restarted.status({ slotId: SLOT });
  const queued = status.leases.find((lease) => lease.id === 'lease-queued');
  // `blocksAcquisition` counts a queued lease, so leaving it queued blocks every
  // other run on this capability forever: its owner is gone and will never
  // retry admission.
  assert.equal(queued?.state, 'released');
  assert.equal(
    actions.some((action) => action === 'browser.release'),
    false,
    'a queued lease holds no provider, so nothing may be stopped for it',
  );
  const rejected = status.events.find(
    (event) => event.kind === 'recovery-rejected' && event.leaseId === 'lease-queued',
  );
  assert.match(rejected?.detail ?? '', /queue slot dropped/);
});

test('terminal cleanup bypasses keep-warm for every lease the run owns', async (t) => {
  const warm = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warm]);
  assert.equal((await acquire(registry, 'metro', 'run-a', 'fam-a')).ok, true);
  actions.length = 0;
  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['metro.release'],
  );
  const status = await registry.status({ slotId: SLOT });
  assert.equal(
    status.leases.every((lease) => lease.keepWarmUntil === undefined),
    true,
  );
});

test('a dependency is retained when its parent failed to release', async (t) => {
  const { registry, actions } = await fixture(
    t,
    [entry('app', 'exclusive', ['metro']), entry('metro')],
    {
      runAction: async (_slotId, action) =>
        action.kind === 'slot-action' && action.actionId === 'app.release'
          ? { ok: false, detail: 'app shutdown exited 1' }
          : { ok: true },
    },
  );
  assert.equal((await acquire(registry, 'app', 'run-a', 'fam-a')).ok, true);
  actions.length = 0;

  const result = await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.capabilityId, 'app');
  // The parent is demonstrably still up, so its dependency must stay up too.
  assert.ok(
    !actions.includes('metro.release'),
    `metro was stopped under a parent that failed to release: ${actions.join(', ')}`,
  );
  assert.deepEqual(
    result.retained.map((lease) => lease.capabilityId),
    ['metro'],
  );
  const status = await registry.status({ slotId: SLOT });
  const metro = status.leases.find((lease) => lease.capabilityId === 'metro');
  assert.equal(metro?.state, 'acquired');
});

test('a failed parent protects its whole dependency chain', async (t) => {
  // A -> B -> C, with B acquired on its own first. The idempotent reuse of B
  // reports no dependency leases, so A records only B and the chain has to be
  // walked link by link: a failed A retains B, and a retained B must retain C.
  const { registry, actions } = await fixture(
    t,
    [entry('a', 'exclusive', ['b']), entry('b', 'exclusive', ['c']), entry('c')],
    {
      runAction: async (_slotId, action) =>
        action.kind === 'slot-action' && action.actionId === 'a.release'
          ? { ok: false, detail: 'a shutdown exited 1' }
          : { ok: true },
    },
  );
  assert.equal((await acquire(registry, 'b', 'run-a', 'fam-a')).ok, true);
  assert.equal((await acquire(registry, 'a', 'run-a', 'fam-a')).ok, true);
  const graph = await registry.status({ slotId: SLOT });
  const parent = graph.leases.find((lease) => lease.capabilityId === 'a')!;
  const grandchild = graph.leases.find((lease) => lease.capabilityId === 'c')!;
  assert.ok(
    !parent.dependencyLeaseIds.includes(grandchild.id),
    'this test is only meaningful when the parent does not list the grandchild',
  );
  actions.length = 0;

  const result = await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  assert.equal(result.ok, false);
  const releases = actions.filter((action) => action.endsWith('.release'));
  assert.deepEqual(releases, ['a.release'], `chain was broken: ${actions.join(', ')}`);
  assert.deepEqual(result.retained.map((lease) => lease.capabilityId).sort(), ['b', 'c']);
  const status = await registry.status({ slotId: SLOT });
  for (const capabilityId of ['b', 'c']) {
    const lease = status.leases.find((candidate) => candidate.capabilityId === capabilityId);
    assert.equal(lease?.state, 'acquired', `${capabilityId} must stay acquired`);
  }
});

test('family terminal cleanup fences the siblings it cleaned', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser', 'shared')]);
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  assert.equal((await acquire(registry, 'browser', 'sibling-run', 'fam-a')).ok, true);

  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  actions.length = 0;

  // The family is done with the slot; a sibling must not pick a provider back up.
  const sibling = await acquire(registry, 'browser', 'sibling-run', 'fam-a');
  assert.equal(sibling.ok, false, 'a fenced family member must not reacquire');
  if (sibling.ok) return;
  assert.match(sibling.conflict.reason, /terminal capability cleanup/);
  // A member that never held a lease is fenced by family too.
  const untouched = await acquire(registry, 'browser', 'late-sibling', 'fam-a');
  assert.equal(untouched.ok, false);
  assert.deepEqual(actions, [], 'nothing may be booted for a terminal family');

  // An unrelated family is unaffected.
  const other = await acquire(registry, 'browser', 'run-b', 'fam-b');
  assert.equal(other.ok, true);
});

test('a sibling whose cleanup failed is still fenced', async (t) => {
  // The initiating run is fenced up front, so the gap is a *sibling*: its lease
  // appears in neither `released` nor `retained` when cleanup fails, and with no
  // run record to derive a family from, the run-id fence is the only guard left.
  const { registry } = await fixture(t, [entry('browser', 'shared')], {
    runAction: async (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'browser.release'
        ? { ok: false, detail: 'browser shutdown exited 1' }
        : { ok: true },
    familyForRun: () => undefined,
  });
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  assert.equal((await acquire(registry, 'browser', 'sibling-run', 'fam-a')).ok, true);

  const result = await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  assert.equal(result.ok, false);
  const accounted = [...result.released, ...result.retained].map((lease) => lease.owner.runId);
  assert.ok(
    !accounted.includes('sibling-run'),
    'this test is only meaningful when the failed sibling is absent from the result',
  );

  const again = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'sibling-run',
    proofRequirement: { capabilityId: 'browser', reason: 'retry', mode: 'state' },
  });
  assert.equal(again.ok, false, 'a sibling whose cleanup failed must not reacquire');
  if (again.ok) return;
  assert.match(again.conflict.reason, /terminal capability cleanup/);
});

test('the family fence cannot be dodged by omitting ownerFamilyId', async (t) => {
  const families = new Map([
    ['run-a', 'fam-a'],
    ['sibling-run', 'fam-a'],
    ['run-b', 'fam-b'],
  ]);
  const { registry } = await fixture(t, [entry('browser', 'shared')], {
    familyForRun: (ownerRunId) => families.get(ownerRunId),
  });
  assert.equal((await acquire(registry, 'browser', 'run-a', 'fam-a')).ok, true);
  await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');

  // The wire param is optional; the registry falls back to the run record.
  const dodged = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'sibling-run',
    proofRequirement: { capabilityId: 'browser', reason: 'sneak', mode: 'state' },
  });
  assert.equal(dodged.ok, false, 'omitting ownerFamilyId must not bypass the fence');
  if (dodged.ok) return;
  assert.match(dodged.conflict.reason, /terminal capability cleanup/);

  // A run in another family is still free to acquire without the param.
  const other = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-b',
    proofRequirement: { capabilityId: 'browser', reason: 'unrelated', mode: 'state' },
  });
  assert.equal(other.ok, true);
});

test('a lease carries the run record family even when the caller omits it', async (t) => {
  const families = new Map([
    ['run-a', 'fam-a'],
    ['sibling-run', 'fam-a'],
  ]);
  const { registry, actions } = await fixture(t, [entry('browser', 'shared')], {
    familyForRun: (ownerRunId) => families.get(ownerRunId),
  });
  // Neither acquire names a family on the wire.
  const first = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'browser', reason: 'work', mode: 'state' },
  });
  assert.equal(first.ok, true);
  const sibling = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'sibling-run',
    proofRequirement: { capabilityId: 'browser', reason: 'work', mode: 'state' },
  });
  assert.equal(sibling.ok, true);

  const before = await registry.status({ slotId: SLOT });
  for (const lease of before.leases) {
    assert.equal(lease.owner.familyId, 'fam-a', `${lease.owner.runId} lost its family`);
  }

  // Family cleanup must therefore find both.
  actions.length = 0;
  const result = await registry.releaseRunTerminal(SLOT, 'run-a', 'fam-a');
  assert.equal(result.ok, true);
  assert.deepEqual(result.released.map((lease) => lease.owner.runId).sort(), [
    'run-a',
    'sibling-run',
  ]);
  const after = await registry.status({ slotId: SLOT });
  assert.deepEqual(
    after.leases.filter((lease) => holdsProviderForTest(lease)),
    [],
  );
  assert.ok(actions.includes('browser.release'));
});

test('a caller-supplied family that contradicts the run record is rejected', async (t) => {
  const { registry, actions } = await fixture(t, [entry('browser')], {
    familyForRun: (ownerRunId) => (ownerRunId === 'run-a' ? 'fam-a' : undefined),
  });
  const mismatched = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    ownerFamilyId: 'fam-someone-else',
    proofRequirement: { capabilityId: 'browser', reason: 'work', mode: 'state' },
  });
  assert.equal(mismatched.ok, false);
  if (mismatched.ok) return;
  assert.equal(mismatched.conflict.kind, 'invalid-request');
  assert.match(mismatched.conflict.reason, /does not match the family of run 'run-a'/);
  // Nothing was created and no provider was booted.
  const status = await registry.status({ slotId: SLOT });
  assert.deepEqual(status.leases, []);
  assert.deepEqual(actions, []);

  // The matching family is accepted.
  const matched = await registry.acquire({
    slotId: SLOT,
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    ownerFamilyId: 'fam-a',
    proofRequirement: { capabilityId: 'browser', reason: 'work', mode: 'state' },
  });
  assert.equal(matched.ok, true);
});

test('stopWarmProviders reports the provider it stopped', async (t) => {
  const warm = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warm]);
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });
  actions.length = 0;

  const summary = await registry.stopWarmProviders(SLOT, ['metro']);
  assert.deepEqual(actions, ['metro.release']);
  assert.deepEqual(
    summary.released.map((lease) => lease.capabilityId),
    ['metro'],
  );
  assert.deepEqual(summary.deferred, []);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.effects, ['release metro']);
});

test('stopWarmProviders defers a warm provider a warm dependent still needs', async (t) => {
  let clock = new Date('2026-08-11T00:00:00.000Z');
  const warmApp = { ...entry('app', 'exclusive', ['metro']), keepWarmMs: 600_000 };
  const warmMetro = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warmApp, warmMetro], { now: () => clock });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  actions.length = 0;
  clock = new Date('2026-08-11T00:01:00.000Z');

  // Asking for the dependency alone must not pull the floor out from under the
  // dependent that is still warm.
  const summary = await registry.stopWarmProviders(SLOT, ['metro']);
  assert.deepEqual([...actions], []);
  assert.deepEqual(summary.released, []);
  assert.deepEqual(
    summary.deferred.map((lease) => lease.capabilityId),
    ['metro'],
  );
});

test('stopWarmProviders reports a cleanup failure instead of claiming stopped', async (t) => {
  const warm = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry } = await fixture(t, [warm], {
    runAction: async (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'metro.release'
        ? { ok: false, detail: 'metro shutdown exited 1' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });

  const summary = await registry.stopWarmProviders(SLOT, ['metro']);
  assert.deepEqual(summary.released, []);
  assert.deepEqual(summary.failures, [
    { leaseId: 'lease-1', capabilityId: 'metro', reason: 'metro shutdown exited 1' },
  ]);
  const status = await registry.status({ slotId: SLOT });
  assert.equal(status.leases[0]?.cleanupFailure, 'metro shutdown exited 1');
});

test('a failed warm cleanup keeps the dependency it still holds', async (t) => {
  const warmApp = { ...entry('app', 'exclusive', ['metro']), keepWarmMs: 600_000 };
  const warmMetro = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warmApp, warmMetro], {
    runAction: async (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'app.release'
        ? { ok: false, detail: 'app shutdown exited 1' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'app', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a' });
  actions.length = 0;

  // Both are warm and both are asked to stop. app fails, so metro must stay.
  const summary = await registry.stopWarmProviders(SLOT, ['app', 'metro']);
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release')),
    ['app.release'],
    `metro was stopped under a parent that failed to stop: ${actions.join(', ')}`,
  );
  assert.deepEqual(
    summary.failures.map((failure) => failure.capabilityId),
    ['app'],
  );
  assert.deepEqual(
    summary.deferred.map((lease) => lease.capabilityId),
    ['metro'],
  );
  assert.deepEqual(summary.released, []);
});

test('an expired warm provider is adopted after a health check, not duplicated', async (t) => {
  let clock = new Date('2026-08-11T00:00:00.000Z');
  const warm = { ...entry('metro'), keepWarmMs: 60_000 };
  const { registry, actions } = await fixture(t, [warm], { now: () => clock });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });

  // Past the deadline, before the sweeper ran: the provider may still be alive.
  clock = new Date('2026-08-11T00:05:00.000Z');
  actions.length = 0;
  const again = await acquire(registry, 'metro', 'run-b');
  assert.equal(again.ok, true);
  assert.ok(actions.includes('metro.health'), `no health check ran: ${actions.join(', ')}`);
  assert.ok(
    !actions.includes('metro.acquire'),
    `a healthy expired-warm provider was started again: ${actions.join(', ')}`,
  );
});

test('an expired warm provider that is dead is cleaned up before a fresh acquire', async (t) => {
  let clock = new Date('2026-08-11T00:00:00.000Z');
  let healthy = true;
  const warm = { ...entry('metro'), keepWarmMs: 60_000 };
  const { registry, actions } = await fixture(t, [warm], {
    now: () => clock,
    runAction: async (_slotId, action) =>
      action.kind === 'slot-action' && action.actionId === 'metro.health' && !healthy
        ? { ok: false, detail: 'metro is not responding' }
        : { ok: true },
  });
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });

  clock = new Date('2026-08-11T00:05:00.000Z');
  healthy = false;
  actions.length = 0;
  const again = await acquire(registry, 'metro', 'run-b');
  // Health fails, so the stale provider is torn down before a new one starts.
  assert.ok(actions.includes('metro.release'), actions.join(', '));
  assert.equal(again.ok, false, 'the dead provider is reported, not silently replaced');
});

test('a stale warm provider is stopped through its own definition when that definition is still in the catalog', async (t) => {
  // The project duplicated the provider under a new id during a migration, so
  // the digest the warm lease carries still resolves — to `metro-legacy`.
  const current = { ...entry('metro'), keepWarmMs: 600_000 };
  const legacy = { ...entry('metro-legacy'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [current, legacy]);
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });

  // Redefine `metro`; its old definition survives under the legacy id.
  legacy.provenance = { ...legacy.provenance, digest: current.provenance.digest };
  current.provenance = { ...current.provenance, digest: 'digest-metro-v2' };
  current.version = '2';
  actions.length = 0;

  const again = await acquire(registry, 'metro', 'run-b');
  assert.equal(again.ok, true);
  // The old provider is stopped through its own release action, not the new one's.
  assert.ok(
    actions.includes('metro-legacy.release'),
    `the old definition's release did not run: ${actions.join(', ')}`,
  );
  assert.ok(actions.includes('metro.acquire'), `no fresh acquire ran: ${actions.join(', ')}`);
  assert.ok(
    actions.indexOf('metro-legacy.release') < actions.indexOf('metro.acquire'),
    `cleanup must precede the fresh acquire: ${actions.join(', ')}`,
  );
});

test('a stale warm provider whose definition is gone fails closed instead of guessing', async (t) => {
  const warm = { ...entry('metro'), keepWarmMs: 600_000 };
  const { registry, actions } = await fixture(t, [warm]);
  assert.equal((await acquire(registry, 'metro', 'run-a')).ok, true);
  await registry.release({ slotId: SLOT, ownerRunId: 'run-a', capabilityId: 'metro' });
  const before = await registry.status({ slotId: SLOT });
  const staleLeaseId = before.leases[0]!.id;
  assert.ok(before.leases[0]?.keepWarmUntil, 'precondition: the lease is warm');

  // The definition that started it is replaced outright and is not in the catalog.
  warm.provenance = { ...warm.provenance, digest: 'digest-metro-v2' };
  warm.version = '2';
  actions.length = 0;

  const again = await acquire(registry, 'metro', 'run-b');
  assert.equal(again.ok, false, 'the acquire must not report success');
  if (again.ok) return;
  assert.equal(again.conflict.kind, 'unavailable');
  assert.match(again.conflict.reason, /no longer in the .* catalog/);
  assert.match(again.conflict.reason, new RegExp(`lease ${staleLeaseId}`));

  // Nothing was guessed from the new definition, and no second provider started.
  assert.deepEqual(
    actions.filter((action) => action.endsWith('.release') || action.endsWith('.acquire')),
    [],
    `an action was run against a definition that did not start the provider: ${actions.join(', ')}`,
  );
  const after = await registry.status({ slotId: SLOT });
  const stale = after.leases.find((l) => l.id === staleLeaseId);
  assert.equal(stale?.state, 'error');
  assert.match(stale?.cleanupFailure ?? '', /Stop the provider, then retry/);
  assert.deepEqual(
    after.leases.filter((l) => holdsProviderForTest(l)),
    [],
    'no second provider may be running',
  );
});

test('affected-resource metadata reaches capability status and is part of the provenance digest', async (t) => {
  const declared = entry('gateway');
  declared.affectedResources = [
    { resourceId: 'dev-server', ownership: 'slot-lifecycle', releaseEffect: 'retain' },
  ];
  const { registry } = await fixture(t, [declared]);

  const status = await registry.status({ slotId: SLOT });
  assert.deepEqual(
    status.catalog.find((capability) => capability.id === 'gateway')?.affectedResources,
    [{ resourceId: 'dev-server', ownership: 'slot-lifecycle', releaseEffect: 'retain' }],
    'machine parking reads this off capability.status, so it must survive the catalog copy',
  );

  // The field changes what a release does, so it belongs in the digest even
  // though that invalidates every live lease once on the deploy that adds it.
  const { id, project, provenance, availability, ...withMetadata } = declared;
  void id;
  void project;
  void provenance;
  void availability;
  const { affectedResources, ...withoutMetadata } = withMetadata;
  void affectedResources;
  assert.notEqual(
    runtimeCapabilityProviderDigest(withMetadata),
    runtimeCapabilityProviderDigest(withoutMetadata),
  );
  assert.notEqual(
    runtimeCapabilityProviderDigest(withMetadata),
    runtimeCapabilityProviderDigest({
      ...withMetadata,
      affectedResources: [
        { resourceId: 'dev-server', ownership: 'slot-lifecycle', releaseEffect: 'stop' },
      ],
    }),
    'flipping retain to stop must not be adoptable under the same digest',
  );
});
