import assert from 'node:assert/strict';
import test from 'node:test';

import { EntityCollection } from '../src/client-cache/entity-collection.js';
import type { SlotStatus } from '../src/contracts/slots.js';
import { computeSummary } from '../src/fleet/summary.js';

// ---------------------------------------------------------------------------
// Test #12: computeSummary parity
// Gateway no longer carries a local copy; both gateway and client import this.
// ---------------------------------------------------------------------------

function makeSlot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'test-01',
    machine: 'macwork',
    platform: 'macos',
    project: 'p',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

test('computeSummary counts all lifecycle buckets correctly', () => {
  const slots: SlotStatus[] = [
    makeSlot({
      slot: 's1',
      lifecycle: 'ready',
      health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      warm: false,
    }),
    makeSlot({
      slot: 's2',
      lifecycle: 'ready',
      health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      warm: true,
    }),
    makeSlot({
      slot: 's3',
      lifecycle: 'ready',
      health: { ssh: 'FAIL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    }),
    makeSlot({ slot: 's4', lifecycle: 'busy' }),
    makeSlot({ slot: 's5', lifecycle: 'held' }),
    makeSlot({ slot: 's6', lifecycle: 'manual' }),
    makeSlot({ slot: 's7', lifecycle: 'disabled' }),
  ];
  const summary = computeSummary(slots);
  assert.equal(summary.total, 7);
  assert.equal(summary.ready, 2, 'healthy ready slots');
  assert.equal(summary.blocked, 1, 'unhealthy ready slot = blocked');
  assert.equal(summary.warmCount, 1, 'warm slot');
  assert.equal(summary.busy, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.manual, 1);
  assert.equal(summary.disabled, 1);
});

test('computeSummary returns zero counts for empty fleet', () => {
  const summary = computeSummary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.ready, 0);
  assert.equal(summary.busy, 0);
});

// ---------------------------------------------------------------------------
// Test #13: zero-reads proof
// EntityCollection.refresh with all versions matching must call fetchPage zero times.
// ---------------------------------------------------------------------------

type TestEntity = { id: string; value: string };

test('EntityCollection.refresh does not call fetchPage when all versions match', async () => {
  const entity: TestEntity = { id: 'e1', value: 'hello' };
  let fetchPageCalls = 0;

  const collection = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: (a, b) => a.id.localeCompare(b.id),
    fetchVersions: async () => ({ versions: [{ id: 'e1', version: 'v1' }] }),
    fetchPage: async (ids) => {
      fetchPageCalls++;
      return { entities: ids.map(() => entity), versions: [{ id: 'e1', version: 'v1' }] };
    },
  });

  // Seed the collection via applyEntity so the row is at version v1.
  collection.applyEntity('e1', entity, 'v1');

  // refresh: fetchVersions returns v1 for e1; row already at v1 → zero fetchPage calls.
  await collection.refresh();
  assert.equal(fetchPageCalls, 0, 'fetchPage must not be called when all versions match');
  assert.ok(collection.complete, 'collection must be complete');
});

test('EntityCollection.refresh calls fetchPage for stale entities', async () => {
  const updated: TestEntity = { id: 'e1', value: 'updated' };
  let fetchPageCalls = 0;

  const collection = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: (a, b) => a.id.localeCompare(b.id),
    fetchVersions: async () => ({ versions: [{ id: 'e1', version: 'v2' }] }),
    fetchPage: async (ids, _signal) => {
      fetchPageCalls++;
      return { entities: ids.map(() => updated), versions: [{ id: 'e1', version: 'v2' }] };
    },
  });

  // Seed at v1 — versions read returns v2 → stale.
  collection.applyEntity('e1', { id: 'e1', value: 'old' }, 'v1');
  await collection.refresh();
  assert.equal(fetchPageCalls, 1, 'fetchPage must be called for stale entity');
  const assembled = collection.assemble();
  assert.deepEqual(assembled, [updated]);
});

test('EntityCollection.needsVersionsRead returns true when no prior listing', () => {
  const collection = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: () => 0,
    fetchVersions: async () => ({ versions: [] }),
    fetchPage: async () => ({ entities: [], versions: [] }),
  });
  assert.ok(collection.needsVersionsRead(5));
  assert.ok(collection.needsVersionsRead(undefined));
});

test('EntityCollection.needsVersionsRead returns false when membershipRevision matches', async () => {
  const collection = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: () => 0,
    fetchVersions: async () => ({ versions: [] }),
    fetchPage: async () => ({ entities: [], versions: [] }),
  });
  await collection.refresh();
  collection.storeMembershipRevision(3);
  assert.ok(!collection.needsVersionsRead(3), 'matching membershipRevision → skip versions read');
  assert.ok(collection.needsVersionsRead(4), 'incremented membershipRevision → need versions read');
});
