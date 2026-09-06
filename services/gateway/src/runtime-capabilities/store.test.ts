import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  RuntimeCapabilityLease,
  RuntimeCapabilityLifecycleEvent,
  RuntimeCapabilityProofPlan,
} from '@farmslot/protocol';

import {
  compactRuntimeCapabilitySnapshot,
  RUNTIME_CAPABILITY_EVENT_LIMIT,
  RUNTIME_CAPABILITY_PROOF_PLAN_LIMIT,
  RUNTIME_CAPABILITY_TERMINAL_FENCE_TTL_MS,
  RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT,
  RuntimeCapabilityStore,
  type RuntimeCapabilityStoreSnapshot,
} from './store.js';

function lease(index: number, state: RuntimeCapabilityLease['state']): RuntimeCapabilityLease {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `lease-${index}`,
    slotId: 'slot-a',
    project: 'test-project',
    capabilityId: 'browser',
    owner: { runId: `run-${index}` },
    state,
    referenceCount: state === 'acquired' ? 1 : 0,
    parameters: {},
    provenance: {
      project: 'test-project',
      providerId: 'browser',
      version: '1',
      digest: 'digest-browser',
    },
    health: { state: 'unknown' },
    dependencyLeaseIds: [],
    updatedAt: at,
  };
}

function plan(index: number): RuntimeCapabilityProofPlan {
  return {
    version: 1,
    slotId: 'slot-a',
    ownerRunId: `run-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    requirements: [],
  };
}

test('store compaction bounds terminal history while retaining active ownership', () => {
  const active = lease(0, 'acquired');
  const terminal = Array.from(
    { length: RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT + 25 },
    (_, index) => lease(index + 1, 'released'),
  );
  const proofPlans = Object.fromEntries(
    Array.from({ length: RUNTIME_CAPABILITY_PROOF_PLAN_LIMIT + 25 }, (_, index) => {
      const value = plan(index);
      return [value.ownerRunId, value];
    }),
  );
  const event = (index: number): RuntimeCapabilityLifecycleEvent => ({
    kind: 'released',
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    slotId: 'slot-a',
    capabilityId: 'browser',
  });
  const snapshot: RuntimeCapabilityStoreSnapshot = {
    version: 1,
    leases: [active, ...terminal],
    proofPlans,
    events: Array.from({ length: RUNTIME_CAPABILITY_EVENT_LIMIT + 25 }, (_, index) => event(index)),
  };

  const compacted = compactRuntimeCapabilitySnapshot(snapshot);
  assert(compacted.leases.some((candidate) => candidate.id === active.id));
  assert.equal(
    compacted.leases.filter((candidate) => candidate.state === 'released').length,
    RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT,
  );
  assert(compacted.proofPlans[active.owner.runId]);
  assert(Object.keys(compacted.proofPlans).length <= RUNTIME_CAPABILITY_PROOF_PLAN_LIMIT + 1);
  assert.equal(compacted.events.length, RUNTIME_CAPABILITY_EVENT_LIMIT);
});

test('store compaction bounds queued admission history that owns no provider', () => {
  const queued = Array.from({ length: RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT + 25 }, (_, index) =>
    lease(index, 'queued'),
  );
  const snapshot: RuntimeCapabilityStoreSnapshot = {
    version: 1,
    leases: queued,
    proofPlans: {},
    events: [],
  };

  const compacted = compactRuntimeCapabilitySnapshot(snapshot);
  assert.equal(compacted.leases.length, RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT);
  assert(compacted.leases.every((candidate) => candidate.state === 'queued'));
  assert(!compacted.leases.some((candidate) => candidate.id === 'lease-0'));
});

test('a warm provider and a cleanup failure survive compaction so reconnects still see them', () => {
  const warm: RuntimeCapabilityLease = {
    ...lease(0, 'released'),
    id: 'lease-warm',
    keepWarmUntil: '2026-01-01T01:00:00.000Z',
  };
  const failed: RuntimeCapabilityLease = {
    ...lease(1, 'error'),
    id: 'lease-failed',
    cleanupFailure: 'shutdown exited 1',
  };
  const churn = Array.from({ length: RUNTIME_CAPABILITY_TERMINAL_LEASE_LIMIT + 50 }, (_, index) =>
    lease(index + 100, 'released'),
  );
  const compacted = compactRuntimeCapabilitySnapshot({
    version: 1,
    leases: [warm, failed, ...churn],
    proofPlans: {},
    events: [],
  });
  const byId = new Map(compacted.leases.map((candidate) => [candidate.id, candidate]));
  assert.equal(byId.get('lease-warm')?.keepWarmUntil, '2026-01-01T01:00:00.000Z');
  assert.equal(byId.get('lease-failed')?.cleanupFailure, 'shutdown exited 1');
});

test('a store file written before the terminal fence existed still loads', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-capability-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'leases.json');
  // Exactly the shape the gateway wrote before the fence was persisted: no
  // version bump, no fence keys. Refusing it would strand every existing store.
  await writeFile(
    storePath,
    `${JSON.stringify({ version: 1, leases: [lease(0, 'acquired')], proofPlans: {}, events: [] })}\n`,
    'utf8',
  );

  const loaded = await new RuntimeCapabilityStore(storePath).load();
  assert.equal(loaded.leases.length, 1);
  assert.equal(loaded.terminalOwners, undefined);
  assert.equal(loaded.terminalFamilies, undefined);
});

test('the terminal fence retires by age, not by count', () => {
  // A count bound evicted the OLDEST entries — exactly the owners whose run
  // records archiving has already deleted, so the live-record fallback meant to
  // cover eviction was blind precisely where eviction bit. Age keeps them.
  const fresh = Array.from({ length: 5_000 }, (_, index) => ({
    id: `run-${index}`,
    at: new Date().toISOString(),
  }));
  const ancient = {
    id: 'run-ancient',
    at: new Date(Date.now() - RUNTIME_CAPABILITY_TERMINAL_FENCE_TTL_MS - 60_000).toISOString(),
  };

  const compacted = compactRuntimeCapabilitySnapshot({
    version: 1,
    leases: [],
    proofPlans: {},
    events: [],
    terminalOwnerEntries: [ancient, ...fresh],
    terminalFamilyEntries: [ancient],
  });

  // Far past any count bound, and all of it kept.
  assert.equal(compacted.terminalOwnerEntries?.length, fresh.length);
  assert.equal(
    compacted.terminalOwnerEntries?.some((entry) => entry.id === 'run-ancient'),
    false,
    'only entries past the TTL are dropped',
  );
  assert.deepEqual(compacted.terminalFamilyEntries, []);
});

test('a fence entry with an unreadable timestamp is kept rather than dropped', () => {
  // Unknown age would otherwise open the fence for exactly the owners whose
  // provenance is least certain.
  const compacted = compactRuntimeCapabilitySnapshot({
    version: 1,
    leases: [],
    proofPlans: {},
    events: [],
    terminalOwnerEntries: [{ id: 'run-unparseable', at: 'not-a-date' }],
  });

  assert.deepEqual(compacted.terminalOwnerEntries, [{ id: 'run-unparseable', at: 'not-a-date' }]);
});

test('a store written before fence entries existed keeps its fence', () => {
  // The migration that must not lose anything: legacy id lists are folded into
  // entries at compaction, so a caller replacing a pre-upgrade snapshot cannot
  // silently erase an existing fence.
  const compacted = compactRuntimeCapabilitySnapshot({
    version: 1,
    leases: [],
    proofPlans: {},
    events: [],
    terminalOwners: ['run-legacy'],
    terminalFamilies: ['fam-legacy'],
  });

  assert.equal(compacted.terminalOwnerEntries?.[0]?.id, 'run-legacy');
  assert.equal(compacted.terminalFamilyEntries?.[0]?.id, 'fam-legacy');
});
