// Slot entities for entity sync (ADR-071 Amendment 4): maintained where slots are written,
// published and read by lookup, never derived from the whole fleet on a read or a push.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

let hashes = 0;
// Entity versions are hashed only through this helper.
const realHash = await import('../resources/entity-version-hash.js');
mock.module('../resources/entity-version-hash.js', {
  namedExports: {
    ...realHash,
    entityVersionHash: (entity: object) => {
      hashes++;
      return realHash.entityVersionHash(entity);
    },
  },
});
const realState = await import('./state.js');
let fleetBuilds = 0;
mock.module('./state.js', {
  namedExports: {
    ...realState,
    getCachedFleet: () => {
      fleetBuilds++;
      return realState.getCachedFleet();
    },
  },
});

const { setCachedFleetForTests, setTaskProgressOverlay, setWorkspaceOverlay } = realState;
const { slotEntityProvider, fleetStatusIds, fleetStatusVersions, FLEET_ENTITY_PAGE_MAX_BYTES } =
  await import('./slot-entities.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { updateMachineMetrics } = await import('./node-health.js');
const { observedFleetStatus, refreshServedWorkspaceObservations } =
  await import('../methods/fleet.js');

function slot(id: string, patch: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: id,
    machine: 'mac-a',
    platform: 'macos',
    project: 'demo',
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
    ...patch,
  };
}

/** A fresh snapshot unless `checkedAt` says otherwise: a stale one is served stale. */
function fleetOf(slots: SlotStatus[], checkedAt = new Date().toISOString()): FleetStatus {
  return {
    checkedAt,
    slots,
    summary: {
      total: slots.length,
      ready: slots.length,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

async function published(run: () => void): Promise<ResourceChangedPayload['changes']> {
  const changes: ResourceChangedPayload['changes'] = [];
  const stop = resourceRevisions.subscribe((payload) => changes.push(...payload.changes));
  try {
    run();
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    stop();
  }
  return changes;
}

test('finding 16: publishing a slot is a lookup, not a fleet rebuild', async (t) => {
  setCachedFleetForTests(fleetOf([slot('a'), slot('b'), slot('c')]));
  t.after(() => setCachedFleetForTests(null));
  await fleetStatusVersions();
  fleetBuilds = 0;
  for (const slotId of ['a', 'b', 'c'])
    assert.ok(slotEntityProvider({ family: 'slot', slotId }), `slot ${slotId} is published`);
  assert.equal(fleetBuilds, 0, 'no provider call assembles the served fleet');
});

test('finding 16: a machine sample advances the machine, not its slots', async (t) => {
  setCachedFleetForTests(
    fleetOf([slot('a', { machine: 'mac-s' }), slot('b', { machine: 'mac-s' })]),
  );
  t.after(() => setCachedFleetForTests(null));
  const changes = await published(() =>
    updateMachineMetrics('mac-s', {
      cpuPercent: 42,
      memoryPercent: 10,
      memoryUsedGb: 1,
      memoryTotalGb: 16,
      diskPercent: 5,
      loadAvg1: 1,
      loadAvg5: 1,
      collectedAt: new Date().toISOString(),
    }),
  );
  const sample = changes.find(({ key }) => key.family === 'node')?.changedEntity;
  assert.equal(
    sample?.family === 'node' ? sample.entity?.system?.cpuPercent : undefined,
    42,
    'the sample rides on the machine key',
  );
  assert.deepEqual(
    changes.filter(({ key }) => key.family === 'slot').map(({ key }) => key),
    [],
    'no slot key advances for a machine sample',
  );
});

test('a slot change is pushed on its key and leaves the membership marker', async (t) => {
  setCachedFleetForTests(fleetOf([slot('a'), slot('b')]));
  t.after(() => setCachedFleetForTests(null));
  const { membershipRevision } = await fleetStatusVersions();
  const changes = await published(() => setTaskProgressOverlay('b', 'Build', 1, 3));
  t.after(() => setTaskProgressOverlay('b', null, 0, 0));
  const pushed = changes.find(({ key }) => key.family === 'slot' && key.slotId === 'b');
  const entity = pushed?.changedEntity;
  assert.equal(entity?.family === 'slot' ? entity.entity?.taskPhase : undefined, 'Build 1/3');
  const collection = changes.find(
    ({ key }) => key.family === 'slots' && Object.keys(key).length === 2,
  );
  assert.equal(collection?.membershipRevision, membershipRevision, 'a data change moves no marker');
});

test('finding 21: versions and ids reads hash nothing', async (t) => {
  setCachedFleetForTests(fleetOf([slot('a'), slot('b'), slot('c')]));
  t.after(() => setCachedFleetForTests(null));
  await fleetStatusVersions();
  hashes = 0;
  const versions = await fleetStatusVersions();
  const page = await fleetStatusIds(['a', 'b', 'c']);
  assert.equal(versions.versions.length, 3);
  assert.equal(page.entities.length, 3);
  assert.equal(hashes, 0, 'reads look versions up');
});

test('finding 23: an ids page is bounded by UTF-8 bytes, not string length', async (t) => {
  // Each slot is ~1.2 MB of UTF-8 but only ~400 K characters.
  const wide = '€'.repeat(400_000);
  setCachedFleetForTests(
    fleetOf([slot('a', { heldReason: wide }), slot('b', { heldReason: wide })]),
  );
  t.after(() => setCachedFleetForTests(null));
  const page = await fleetStatusIds(['a', 'b']);
  assert.ok(Buffer.byteLength(JSON.stringify(page.entities[0])) * 2 > FLEET_ENTITY_PAGE_MAX_BYTES);
  assert.deepEqual(
    page.entities.map((row) => row.slot),
    ['a'],
    'the second slot waits for the next page',
  );
});

test('an overlay write changes the maintained entity and the full read alike', async (t) => {
  setCachedFleetForTests(fleetOf([slot('a'), slot('b')]));
  t.after(() => setCachedFleetForTests(null));
  const before = await fleetStatusVersions();
  setTaskProgressOverlay('a', 'Validate', 2, 4);
  const after = await fleetStatusVersions();
  const changed = after.versions.filter(
    (entry, index) => entry.version !== before.versions[index].version,
  );
  assert.deepEqual(
    changed.map((entry) => entry.id),
    ['a'],
  );
  const full = observedFleetStatus(await realState.loadFleetStatus(false, true)).fleet.slots;
  const page = await fleetStatusIds(['a', 'b']);
  for (const row of page.entities) {
    const read = full.find((entry) => entry.slot === row.slot);
    assert.ok(read, `slot ${row.slot} is in the full read`);
    const { hostLoad: _hostLoad, ...served } = read;
    // Compared as sent: JSON drops undefined fields on both sides.
    assert.deepEqual(
      JSON.parse(JSON.stringify(row)),
      JSON.parse(JSON.stringify(served)),
      `slot ${row.slot} equals the full read without host load`,
    );
  }
  assert.equal(page.entities[0].taskPhase, 'Validate 2/4');
});

test('B: on a snapshot past the stale threshold the entity view equals the observed full read', async (t) => {
  setCachedFleetForTests({
    ...fleetOf([slot('a'), slot('b')]),
    checkedAt: '2000-01-01T00:00:00.000Z',
  });
  t.after(() => setCachedFleetForTests(null));
  // The client's own view, from the protocol source: what an entity-sync client assembles.
  const { createFleetEntityView } =
    await import('../../../../packages/protocol/src/client-cache/entity-views.js');
  const view = createFleetEntityView();
  await view.sync(async (params) => {
    const ids = params && typeof params === 'object' ? Reflect.get(params, 'ids') : undefined;
    return Array.isArray(ids) ? fleetStatusIds(ids) : fleetStatusVersions();
  });
  const observed = observedFleetStatus(await realState.loadFleetStatus(false, true));
  // Compared as sent: JSON drops undefined fields on both sides.
  assert.deepEqual(
    JSON.parse(JSON.stringify(view.answer()?.data)),
    JSON.parse(JSON.stringify(observed)),
  );
  // The observed read a cache client sends has never applied the plain read's stale transform.
  assert.equal(observed.fleet.stale, undefined);
  assert.deepEqual(
    observed.fleet.slots.map((row) => row.dispatchable),
    [true, true],
  );
});

test("N9: a failed inspection's fallback workspace leaves the entity when it leaves the full read", async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const id = 'fallback';
  setCachedFleetForTests(fleetOf([slot(id, { currentRunId: null })]));
  t.after(() => setCachedFleetForTests(null));
  // The slot's row verified this workspace a moment ago.
  setWorkspaceOverlay(id, {
    epoch: 0,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'main',
    headSha: 'abc1234',
    dirtyFingerprint: '',
    recoveryId: null,
    observedAt: new Date().toISOString(),
    localDefaultSha: null,
    defaultFetchedAt: null,
    remoteDefaultSha: null,
    remoteObservedAt: null,
    behind: null,
    remoteAdvanced: false,
    publication: 'pushed',
    dirtyCount: 0,
    unpublishedCount: 0,
  });
  t.after(() => setWorkspaceOverlay(id, undefined));
  const full = async () =>
    observedFleetStatus(await realState.loadFleetStatus(false, true)).fleet.slots[0];
  const entity = async () => (await fleetStatusIds([id])).entities[0];

  // Its inspection fails (no pool declares the slot): the row's workspace is kept, unverified.
  refreshServedWorkspaceObservations();
  // The clock is mocked: the ceiling for the inspection is measured on the performance clock.
  const ceiling = performance.now() + 3000;
  while (!(await entity()).workspaceError && performance.now() < ceiling)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await entity()).workspace?.publication, 'unknown');
  assert.equal((await full()).workspace?.publication, 'unknown', 'as the full read shows it');

  // The row's own evidence ages out: the full read drops the fallback, and so does the entity.
  t.mock.timers.tick(30_001);
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await entity()).workspace, undefined, 'the entity follows the same expiry');
  assert.equal((await full()).workspace, undefined);
});

test('a stale snapshot is served stale by the observed read and named stale by the versions read', async (t) => {
  // Older than any freshness threshold: the plain read has always served this as stale.
  setCachedFleetForTests(fleetOf([slot('a'), slot('b')], '2000-01-01T00:00:00.000Z'));
  t.after(() => setCachedFleetForTests(null));
  const observed = observedFleetStatus(await realState.loadFleetStatus(false, true)).fleet;
  assert.equal(observed.stale, true);
  assert.deepEqual(
    observed.slots.map((row) => row.dispatchable),
    [false, false],
    'no slot of a stale fleet is dispatchable',
  );
  assert.equal((await fleetStatusVersions()).stale, true);
  // The entities keep their own facts; the client applies the same rule to what it holds.
  const page = await fleetStatusIds(['a', 'b']);
  assert.deepEqual(
    page.entities.map((row) => row.dispatchable),
    [true, true],
  );

  setCachedFleetForTests(fleetOf([slot('a'), slot('b')]));
  const fresh = observedFleetStatus(await realState.loadFleetStatus(false, true)).fleet;
  assert.equal(fresh.stale, undefined);
  assert.deepEqual(
    fresh.slots.map((row) => row.dispatchable),
    [true, true],
  );
  assert.equal((await fleetStatusVersions()).stale, undefined);
});
