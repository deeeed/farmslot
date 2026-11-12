// Workspace inspections under entity sync (ADR-071 Amendment 3). An observed full fleet read
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

const { setCachedFleetForTests } = await import('../fleet/state.js');
const { fleetStatusIds } = await import('../fleet/slot-entities.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const {
  refreshServedWorkspaceObservations,
  slotsPublishedToViewers,
  stopServedWorkspaceObservations,
} = await import('./fleet.js');

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
