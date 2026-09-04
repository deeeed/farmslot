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

import { RuntimeCapabilityRegistry } from './registry.js';
import { RuntimeCapabilityStore } from './store.js';

const SLOT = 'slot-a';

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
    runAction?: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['runAction'];
    onEvent?: (event: RuntimeCapabilityLifecycleEvent) => void;
    storeFactory?: (storePath: string) => RuntimeCapabilityStore;
    now?: () => Date;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actions: string[] = [];
  let nextLease = 0;
  const storePath = path.join(directory, 'leases.json');
  const registry = new RuntimeCapabilityRegistry({
    store: options.storeFactory?.(storePath) ?? new RuntimeCapabilityStore(storePath),
    catalogForSlot: async (slotId) => ({ slotId, project: 'test-project', capabilities }),
    runAction: async (_slotId, action) => {
      actions.push(
        action.kind === 'slot-action' ? action.actionId : `${action.resourceId}.${action.action}`,
      );
      return options.runAction ? options.runAction(_slotId, action) : { ok: true };
    },
    ...(options.pressureFor ? { pressureFor: options.pressureFor } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    leaseId: () => `lease-${++nextLease}`,
    now: options.now ?? (() => new Date('2026-08-11T00:00:00.000Z')),
  });
  return { registry, actions };
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
