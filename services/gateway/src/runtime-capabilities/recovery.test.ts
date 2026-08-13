import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RuntimeCapabilityCatalogEntry } from '@farmslot/protocol';

import { reconcileRuntimeCapabilityLeases } from './recovery.js';
import { RuntimeCapabilityRegistry } from './registry.js';
import { RuntimeCapabilityStore } from './store.js';

function browser(digest = 'browser-digest'): RuntimeCapabilityCatalogEntry {
  return {
    id: 'browser',
    project: 'test-project',
    label: 'Browser',
    version: '1',
    dependencies: [],
    sharePolicy: 'exclusive',
    cost: { class: 'high', resources: [] },
    actions: {
      acquire: { kind: 'slot-action', actionId: 'browser.acquire' },
      health: { kind: 'slot-action', actionId: 'browser.health' },
      release: { kind: 'slot-action', actionId: 'browser.release' },
    },
    releaseEffects: ['stop browser'],
    provenance: {
      project: 'test-project',
      providerId: 'browser',
      version: '1',
      digest,
    },
    availability: { state: 'available' },
  };
}

async function seededStore(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RuntimeCapabilityStore(path.join(directory, 'leases.json'));
  const seed = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [browser()],
    }),
    runAction: async () => ({ ok: true }),
    leaseId: () => 'lease-browser',
  });
  const acquired = await seed.acquire({
    slotId: 'slot-a',
    capabilityId: 'browser',
    ownerRunId: 'run-a',
    proofRequirement: { capabilityId: 'browser', reason: 'visual proof', mode: 'visual' },
  });
  assert.equal(acquired.ok, true);
  return store;
}

function recoveringRegistry(
  store: RuntimeCapabilityStore,
  capabilities: RuntimeCapabilityCatalogEntry[],
  runAction: ConstructorParameters<typeof RuntimeCapabilityRegistry>[0]['runAction'],
) {
  return new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({ slotId, project: 'test-project', capabilities }),
    runAction,
  });
}

test('restart records a catalog lookup failure without aborting reconciliation', async (t) => {
  const store = await seededStore(t);
  let failCatalog = true;
  const registry = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => {
      if (failCatalog) throw new Error('slot config removed');
      return { slotId, project: 'test-project', capabilities: [browser()] };
    },
    runAction: async () => ({ ok: true }),
  });

  await assert.doesNotReject(() => reconcileRuntimeCapabilityLeases(registry));
  failCatalog = false;
  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'error');
  assert.match(status.leases[0]?.cleanupFailure ?? '', /catalog unavailable.*cleanup refused/i);
  assert(status.events.some((event) => event.kind === 'recovery-rejected'));
});

test('restart adopts a matching healthy lease with provenance intact', async (t) => {
  const store = await seededStore(t);
  const registry = recoveringRegistry(store, [browser()], async (_slot, action) => ({
    ok: action.kind === 'slot-action' && action.actionId === 'browser.health',
  }));
  await reconcileRuntimeCapabilityLeases(registry);
  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'acquired');
  assert.equal(status.leases[0]?.health.state, 'healthy');
  assert(status.events.some((event) => event.kind === 'recovery-adopted'));
});

test('restart rejects stale provenance and ambiguous exclusive ownership', async (t) => {
  const staleStore = await seededStore(t);
  const stale = recoveringRegistry(staleStore, [browser('changed-digest')], async () => ({
    ok: true,
  }));
  await reconcileRuntimeCapabilityLeases(stale);
  assert.equal((await stale.status({ slotId: 'slot-a' })).leases[0]?.state, 'error');

  const ambiguousStore = await seededStore(t);
  const snapshot = ambiguousStore.snapshot();
  snapshot.leases.push({
    ...structuredClone(snapshot.leases[0]!),
    id: 'lease-browser-other',
    owner: { runId: 'run-b' },
  });
  await ambiguousStore.replace(snapshot);
  const ambiguous = recoveringRegistry(ambiguousStore, [browser()], async () => ({ ok: true }));
  await reconcileRuntimeCapabilityLeases(ambiguous);
  const ambiguousStatus = await ambiguous.status({ slotId: 'slot-a' });
  assert.deepEqual(
    ambiguousStatus.leases.map((lease) => lease.state),
    ['error', 'error'],
  );
  assert(ambiguousStatus.events.some((event) => event.kind === 'recovery-rejected'));
});

test('restart records cleanup failure without claiming the lease was released', async (t) => {
  const store = await seededStore(t);
  const registry = recoveringRegistry(store, [browser()], async (_slot, action) => {
    if (action.kind !== 'slot-action') return { ok: false };
    if (action.actionId === 'browser.health') return { ok: false, detail: 'not healthy' };
    if (action.actionId === 'browser.release') return { ok: false, detail: 'stop refused' };
    return { ok: true };
  });
  await reconcileRuntimeCapabilityLeases(registry);
  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'error');
  assert.equal(status.leases[0]?.cleanupFailure, 'stop refused');
  assert(status.events.some((event) => event.kind === 'cleanup-failed'));
  assert.equal(
    status.events.some((event) => event.kind === 'released'),
    false,
  );
});
