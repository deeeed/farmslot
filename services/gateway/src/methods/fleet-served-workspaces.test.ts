// Workspace inspections under entity sync (ADR-071 Amendment 4). An observed full fleet read
// starts them; a viewer that applies pushed slots sends no such read, so its versions read and
// the slot publications it receives start them instead, and each outcome is pushed.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

// An inspection starts by loading its slot's configuration: a test holds a round there.
let heldRound: Promise<void> | undefined;
const realConfig = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async (slotId: string) => {
      await heldRound;
      return realConfig.loadSlotVars(slotId);
    },
  },
});

await import('../runtime/mock-pty.test-support.js');
const { overlaySlotEntity, setCachedFleetForTests, setWorkspaceOverlay } =
  await import('../fleet/state.js');
const { disposeServerResourceObservations } = await import('../server.js');
const { fleetStatusIds } = await import('../fleet/slot-entities.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const {
  fleetStatus,
  refreshServedWorkspaceObservations,
  slotsPublishedToViewers,
  stopServedWorkspaceObservations,
} = await import('./fleet.js');
const { observedSlotWorkspace } = await import('./slot/workspace.js');

function fleetOf(id: string, patch: Partial<SlotStatus> = {}): FleetStatus {
  const slot: SlotStatus = {
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
  return {
    checkedAt: '2026-11-12T00:00:00.000Z',
    slots: [slot],
    summary: {
      total: 1,
      ready: 1,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

/** The slot entity pushed for `id` once `start` has run, within `turns` event-loop turns. */
async function pushedSlotWithin(id: string, turns: number, start: () => void) {
  const changes: ResourceChangedPayload['changes'] = [];
  const stop = resourceRevisions.subscribe((payload) => changes.push(...payload.changes));
  try {
    start();
    const pushed = () => changes.find(({ key }) => key.family === 'slot' && key.slotId === id);
    for (let turn = 0; !pushed() && turn < turns; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const entity = pushed()?.changedEntity;
    return entity?.family === 'slot' ? entity.entity : undefined;
  } finally {
    stop();
  }
}

const pushedSlot = (id: string, start: () => void) => pushedSlotWithin(id, 2000, start);

test('a versions read starts workspace inspections and their outcome is pushed', async (t) => {
  setCachedFleetForTests(fleetOf('versions-reader'));
  t.after(() => setCachedFleetForTests(null));
  const before = (await fleetStatusIds(['versions-reader'])).entities[0];
  assert.equal(before.workspace ?? before.workspaceError, undefined, 'not inspected yet');

  const row = await pushedSlot('versions-reader', refreshServedWorkspaceObservations);
  // No pool declares this slot, so its inspection reports why; either outcome is pushed.
  assert.ok(row?.workspace ?? row?.workspaceError, 'the inspection outcome reaches the slot');
});

test('slot publications to viewers start inspections no more often than a reread', async (t) => {
  setCachedFleetForTests(fleetOf('pushed-viewer'));
  t.after(() => setCachedFleetForTests(null));
  t.after(stopServedWorkspaceObservations);
  // The previous inspection round was more than a reread floor ago.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 60_000 });

  const first = await pushedSlot('pushed-viewer', () => {
    slotsPublishedToViewers();
    t.mock.timers.tick(1);
  });
  assert.ok(first?.workspace ?? first?.workspaceError, 'the inspection outcome reaches the slot');

  // That outcome is itself a slot publication, and more follow several times a second.
  setCachedFleetForTests(fleetOf('next-round'));
  const early = await pushedSlotWithin('next-round', 20, () => {
    for (let i = 0; i < 5; i++) slotsPublishedToViewers();
    t.mock.timers.tick(9_000);
  });
  assert.equal(early, undefined, 'the next round waits for the reread floor');
  const later = await pushedSlot('next-round', () => t.mock.timers.tick(1_001));
  assert.ok(later?.workspace ?? later?.workspaceError, 'then it runs once');
});

test('N5: a refresh asked for while a round runs is run when that round settles', async (t) => {
  setCachedFleetForTests(fleetOf('new-owner'));
  t.after(() => setCachedFleetForTests(null));
  let release = () => {};
  heldRound = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => {
    heldRound = undefined;
    release();
  });
  // A round inspects the slot for its first owner and is still running.
  refreshServedWorkspaceObservations();
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));

  // The slot changes owner, so that inspection no longer describes it; the publication's refresh
  // fires while the first round runs.
  setCachedFleetForTests(fleetOf('new-owner', { currentRunId: 'run-2' }));
  refreshServedWorkspaceObservations();

  const row = await pushedSlot('new-owner', () => {
    heldRound = undefined;
    release();
  });
  assert.equal(row?.currentRunId, 'run-2');
  assert.ok(row?.workspace ?? row?.workspaceError, 'the new owner is inspected');
});

test('R5: disposing the server observations stops the pending inspections and expiries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 120_000 });
  const fallback = fleetOf('teardown-fallback', { currentRunId: null }).slots[0];
  const other = (patch: Partial<SlotStatus> = {}) => fleetOf('teardown-other', patch).slots[0];
  const fleet = (slots: SlotStatus[]): FleetStatus => ({ ...fleetOf('unused'), slots });
  setCachedFleetForTests(fleet([fallback, other()]));
  t.after(() => setCachedFleetForTests(null));
  // The first slot's row verified this workspace a moment ago; its inspection then fails, so
  // its entity shows that workspace unverified until the row's evidence ages out.
  setWorkspaceOverlay(fallback.slot, {
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
  t.after(() => setWorkspaceOverlay(fallback.slot, undefined));
  const entity = async (id: string) => (await fleetStatusIds([id])).entities[0];
  refreshServedWorkspaceObservations();
  const ceiling = performance.now() + 3000;
  while (!(await entity(fallback.slot)).workspaceError && performance.now() < ceiling)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await entity(fallback.slot)).workspace?.publication, 'unknown');

  // Those inspections age out. A round is then held; a second refresh waits behind it, the other
  // slot changes owner meanwhile, and a slot publication arms the viewer timer.
  t.mock.timers.tick(16_000);
  let release = () => {};
  heldRound = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => {
    heldRound = undefined;
    release();
  });
  refreshServedWorkspaceObservations();
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  setCachedFleetForTests(fleet([fallback, other({ currentRunId: 'run-2' })]));
  refreshServedWorkspaceObservations();
  slotsPublishedToViewers();

  disposeServerResourceObservations();
  const changes: ResourceChangedPayload['changes'] = [];
  t.after(resourceRevisions.subscribe((payload) => changes.push(...payload.changes)));
  heldRound = undefined;
  release();
  for (let turn = 0; turn < 200; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  // Past the reread floor and the fallback's expiry.
  t.mock.timers.tick(30_000);
  for (let turn = 0; turn < 200; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));

  const newOwner = await entity('teardown-other');
  assert.equal(newOwner.workspace ?? newOwner.workspaceError, undefined, 'no round starts');
  assert.equal(
    (await entity(fallback.slot)).workspace?.publication,
    'unknown',
    'no expiry recomputes the entity',
  );
  // Neither an expiry nor the round that was running publishes after disposal.
  assert.deepEqual(
    changes.filter(({ key }) => key.family === 'slot'),
    [],
    'no slot is published again',
  );
});

test('E: an inspection that completes after disposal publishes nothing and arms no expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 240_000 });
  const slot = fleetOf('late-failure', { currentRunId: null }).slots[0];
  setCachedFleetForTests(fleetOf('late-failure', { currentRunId: null }));
  t.after(() => setCachedFleetForTests(null));
  // The slot's row verified this workspace a moment ago, and it has never been inspected.
  setWorkspaceOverlay(slot.slot, {
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
  t.after(() => setWorkspaceOverlay(slot.slot, undefined));
  let release = () => {};
  heldRound = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => {
    heldRound = undefined;
    release();
  });
  // Its first inspection is running when the server observations are disposed.
  refreshServedWorkspaceObservations();
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  disposeServerResourceObservations();
  const changes: ResourceChangedPayload['changes'] = [];
  t.after(resourceRevisions.subscribe((payload) => changes.push(...payload.changes)));

  // The inspection then fails (no pool declares the slot).
  heldRound = undefined;
  release();
  const inspected = () => observedSlotWorkspace(overlaySlotEntity(slot)).workspaceError;
  // The clock is mocked: the ceiling for the inspection is measured on the performance clock.
  const ceiling = performance.now() + 3000;
  while (!inspected() && performance.now() < ceiling)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(inspected(), 'the inspection completed');
  for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  // Past the fallback's expiry: a timer armed by that completion would publish the slot now.
  t.mock.timers.tick(30_001);
  for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    changes.filter(({ key }) => key.family === 'slot' && key.slotId === slot.slot),
    [],
    'nothing is published after disposal',
  );
});

test('disposal while the reloaded fleet is awaited publishes nothing and arms no expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 360_000 });
  const id = 'held-reload';
  setCachedFleetForTests(fleetOf(id));
  t.after(() => setCachedFleetForTests(null));
  // The inspection finishes before disposal; the reload that follows it is held.
  let release = () => {};
  const heldReload = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  let loads = 0;
  let reloading = false;
  const published: FleetStatus[] = [];
  await fleetStatus(
    undefined,
    {
      load: async () => {
        if (++loads === 1) return fleetOf(id);
        reloading = true;
        await heldReload;
        // The reloaded row differs from the inspected one: without the fence it is published.
        return fleetOf(id, { workspaceError: 'Observation unavailable' });
      },
      // The fixture's checkedAt is stale under the mocked clock: the status read kicks this.
      refresh: async () => ({ fleet: fleetOf(id) }),
      workspaces: { read: (fleet) => fleet, refresh: async (fleet) => fleet },
    },
    (fleet) => published.push(fleet),
  );
  const ceiling = performance.now() + 3000;
  while (!reloading && performance.now() < ceiling)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(reloading, 'the reload is awaited');

  disposeServerResourceObservations();
  const changes: ResourceChangedPayload['changes'] = [];
  t.after(resourceRevisions.subscribe((payload) => changes.push(...payload.changes)));
  release();
  for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  // Past the fallback's expiry: a timer armed by a recomputed entity would publish the slot now.
  t.mock.timers.tick(30_001);
  for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(published, [], 'no fleet.updated');
  assert.deepEqual(
    changes.filter(({ key }) => key.family === 'slot' && key.slotId === id),
    [],
    'no slot is published after disposal',
  );
});
