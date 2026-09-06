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

test('restart does not adopt a healthy lease owned by a terminal run', async (t) => {
  const store = await seededStore(t);
  const actions: string[] = [];
  const registry = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [browser()],
    }),
    runAction: async (_slot, action) => {
      if (action.kind === 'slot-action') actions.push(action.actionId);
      return { ok: true };
    },
    // The run store, not the registry's own memory: this is exactly the state a
    // restart comes back to after the run went terminal.
    isTerminalOwner: (ownerRunId) => ownerRunId === 'run-a',
  });

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'released');
  // The provider is stopped rather than adopted; a health probe would have
  // promoted it straight back to `acquired` for a run that no longer exists.
  assert.deepEqual(actions, ['browser.release']);
  const rejected = status.events.find((event) => event.kind === 'recovery-rejected');
  assert.match(rejected?.detail ?? '', /terminal capability cleanup/);
  // The event says what happened to the PROVIDER, not just to the lease.
  assert.match(rejected?.detail ?? '', /provider stopped/);
  assert.equal(
    status.events.some((event) => event.kind === 'recovery-adopted'),
    false,
  );
});

test('a fenced lease whose provider stop fails is not reported as released', async (t) => {
  const store = await seededStore(t);
  const registry = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [browser()],
    }),
    runAction: async (_slot, action) =>
      action.kind === 'slot-action' && action.actionId === 'browser.release'
        ? { ok: false, detail: 'shutdown refused' }
        : { ok: true },
    isTerminalOwner: (ownerRunId) => ownerRunId === 'run-a',
  });

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'error');
  assert.equal(status.leases[0]?.cleanupFailure, 'shutdown refused');
  const rejected = status.events.find((event) => event.kind === 'recovery-rejected');
  // The provider may still be up, so the event must not claim it went away.
  assert.match(rejected?.detail ?? '', /provider stop FAILED/);
  assert.doesNotMatch(rejected?.detail ?? '', /provider stopped/);
});

test('restart still adopts a healthy lease owned by a live run', async (t) => {
  const store = await seededStore(t);
  const registry = new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      capabilities: [browser()],
    }),
    runAction: async (_slot, action) => ({
      ok: action.kind === 'slot-action' && action.actionId === 'browser.health',
    }),
    isTerminalOwner: () => false,
  });

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'acquired');
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

test('restart adopts an exclusive holder without counting its queued sibling as an owner', async (t) => {
  const store = await seededStore(t);
  const snapshot = store.snapshot();
  snapshot.leases.push({
    ...structuredClone(snapshot.leases[0]!),
    id: 'lease-browser-queued',
    state: 'queued',
    owner: { runId: 'run-b' },
    health: { state: 'unknown', checkedAt: snapshot.leases[0]!.updatedAt },
  });
  await store.replace(snapshot);
  const registry = recoveringRegistry(store, [browser()], async (_slot, action) => ({
    ok: action.kind === 'slot-action' && action.actionId === 'browser.health',
  }));

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.deepEqual(
    status.leases.map((lease) => lease.state),
    ['acquired', 'queued'],
  );
  assert(status.events.some((event) => event.kind === 'recovery-adopted'));
  assert.equal(
    status.events.some((event) => event.kind === 'recovery-rejected'),
    false,
  );
});

test('restart resumes an interrupted release instead of adopting it as acquired', async (t) => {
  const store = await seededStore(t);
  const snapshot = store.snapshot();
  snapshot.leases[0]!.state = 'releasing';
  await store.replace(snapshot);
  const actions: string[] = [];
  const registry = recoveringRegistry(store, [browser()], async (_slot, action) => {
    if (action.kind === 'slot-action') actions.push(action.actionId);
    return { ok: true };
  });

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.deepEqual(actions, ['browser.release']);
  assert.equal(status.leases[0]?.state, 'released');
  assert.equal(status.leases[0]?.referenceCount, 0);
  assert(status.events.some((event) => event.kind === 'released'));
  assert.equal(
    status.events.some((event) => event.kind === 'recovery-adopted'),
    false,
  );
});

test('restart preserves an interrupted release cleanup failure as an error lease', async (t) => {
  const store = await seededStore(t);
  const snapshot = store.snapshot();
  snapshot.leases[0]!.state = 'releasing';
  await store.replace(snapshot);
  const registry = recoveringRegistry(store, [browser()], async (_slot, action) => ({
    ok: false,
    detail:
      action.kind === 'slot-action' && action.actionId === 'browser.release'
        ? 'release still refused'
        : 'unexpected action',
  }));

  await reconcileRuntimeCapabilityLeases(registry);

  const status = await registry.status({ slotId: 'slot-a' });
  assert.equal(status.leases[0]?.state, 'error');
  assert.equal(status.leases[0]?.cleanupFailure, 'release still refused');
  assert(status.events.some((event) => event.kind === 'cleanup-failed'));
  assert.equal(
    status.events.some((event) => event.kind === 'released'),
    false,
  );
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

/** A provider whose cost is one fleet-scoped exclusive claim on a shared helper. */
function recorder(): RuntimeCapabilityCatalogEntry {
  return {
    ...browser(),
    id: 'recording',
    label: 'Recording',
    cost: {
      class: 'low',
      resources: [{ id: 'capture-helper', access: 'exclusive', kind: 'device', scope: 'fleet' }],
    },
    actions: {
      acquire: { kind: 'slot-action', actionId: 'recording.acquire' },
      health: { kind: 'slot-action', actionId: 'recording.health' },
      release: { kind: 'slot-action', actionId: 'recording.release' },
    },
    provenance: {
      project: 'test-project',
      providerId: 'recording',
      version: '1',
      digest: 'browser-digest',
    },
  };
}

function scopedRegistry(
  store: RuntimeCapabilityStore,
  options: { now?: () => Date; leaseId?: () => string } = {},
) {
  return new RuntimeCapabilityRegistry({
    store,
    catalogForSlot: async (slotId) => ({
      slotId,
      project: 'test-project',
      machine: 'macwork',
      capabilities: [recorder(), { ...recorder(), id: 'camera', label: 'Camera' }],
    }),
    runAction: async () => ({ ok: true }),
    ...options,
  });
}

test('a claim queue keeps its order across a gateway restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'leases.json');
  let clock = Date.parse('2026-09-05T00:00:00.000Z');
  // Lease ids that sort AGAINST the enqueue order, so only a sort that reads
  // `enqueuedAt` can put run-b in front of run-c.
  const ids = ['lease-holder', 'lease-z', 'lease-a'];
  let nextId = 0;
  const before = scopedRegistry(new RuntimeCapabilityStore(storePath), {
    now: () => new Date((clock += 1000)),
    leaseId: () => ids[nextId++] ?? `lease-${nextId}`,
  });
  const wait = (slotId: string, ownerRunId: string) =>
    before.acquire({
      slotId,
      capabilityId: 'recording',
      ownerRunId,
      proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
      queueOnConflict: true,
    });
  assert.equal(
    (
      await before.acquire({
        slotId: 'slot-a',
        capabilityId: 'recording',
        ownerRunId: 'run-a',
        proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
      })
    ).ok,
    true,
  );
  assert.equal((await wait('slot-b', 'run-b')).ok, false);
  assert.equal((await wait('slot-c', 'run-c')).ok, false);

  // A fresh registry over the same file: nothing renumbers, so the derived
  // order has to come back out of `enqueuedAt` alone.
  const after = scopedRegistry(new RuntimeCapabilityStore(storePath));
  await after.recover(['slot-a', 'slot-b', 'slot-c']);
  const status = await after.status({ slotId: 'slot-b' });
  assert.deepEqual(
    status.claimWaiters?.map((waiter) => [waiter.position, waiter.owner.runId]),
    [
      [1, 'run-b'],
      [2, 'run-c'],
    ],
  );
  assert.deepEqual(
    (await after.status({ slotId: 'slot-c' })).leases.map((lease) => lease.state),
    ['queued'],
    'a restored queue slot is still queued, not re-derived as anything else',
  );
});

test('a lease written before claim scopes existed stays slot-scoped', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'leases.json');
  const store = new RuntimeCapabilityStore(storePath);
  const registry = scopedRegistry(store);
  assert.equal(
    (
      await registry.acquire({
        slotId: 'slot-a',
        capabilityId: 'recording',
        ownerRunId: 'run-a',
        proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
      })
    ).ok,
    true,
  );
  // Strip what a pre-scope Gateway never wrote, then reload from disk.
  const snapshot = store.snapshot();
  for (const lease of snapshot.leases) {
    delete lease.claims;
    delete lease.machine;
  }
  await store.replace(snapshot);

  const reloaded = scopedRegistry(new RuntimeCapabilityStore(storePath));
  const foreign = await reloaded.acquire({
    slotId: 'slot-b',
    capabilityId: 'recording',
    ownerRunId: 'run-b',
    proofRequirement: { capabilityId: 'recording', reason: 'record', mode: 'state' },
  });
  assert.equal(foreign.ok, true, 'a lease with no recorded claims arbitrates only on its own slot');
  // On its OWN slot it still arbitrates, read from the catalog exactly as it
  // was before claims were persisted.
  const sameSlot = await reloaded.acquire({
    slotId: 'slot-a',
    capabilityId: 'camera',
    ownerRunId: 'run-c',
    proofRequirement: { capabilityId: 'camera', reason: 'record', mode: 'state' },
  });
  assert.equal(sameSlot.ok, false);
  if (sameSlot.ok) return;
  assert.equal(sameSlot.conflict.kind, 'lease-conflict');
  assert.match(sameSlot.conflict.reason, /capture-helper/);
});
