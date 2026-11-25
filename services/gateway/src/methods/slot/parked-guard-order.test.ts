import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

await import('../../runtime/mock-pty.test-support.js');

// A parked restore and the parked-work retention pass both hold the prepare guard while they
// rewrite a ready slot. Each must hand the guard back before the slot reads ready again, and
// never take or drop a guard another holder took while it awaited. Everything is stubbed.
const SLOT = 'parked-fixture';
const events: string[] = [];
// Runs in the middle of an awaited step, as another holder taking the guard would.
let duringCheck = () => {};
let duringReady = () => {};
// False when a claim commits between the guard and the releasing fence.
let fenceApplies = true;

const { activePrepareSlots } = await import('./shared.js');
const protocol = await import('@farmslot/protocol');
mock.module('@farmslot/protocol', {
  namedExports: {
    ...protocol,
    slotRecoveryEligibility: () => ({ allowed: true }),
  },
});
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => ({ slotId: SLOT, projectName: 'fixture' }),
    loadProjectVars: async () => ({ projectJson: {} }),
    readSlotRow: async () => ({ lifecycle: 'ready', phase: null, slot_epoch: 1 }),
    markSlotStatusIf: async () => {
      if (!fenceApplies) return { applied: false, epoch: 2 };
      events.push('releasing fence');
      return { applied: true, epoch: 1 };
    },
    updateSlotStatusIf: async (_slot: string, _owns: unknown, fields: Record<string, unknown>) => {
      if (fields.lifecycle === 'ready') {
        events.push(`ready, guard ${activePrepareSlots.has(SLOT) ? 'held' : 'free'}`);
        duringReady();
      }
      return true;
    },
  },
});
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots: [{ slot: SLOT }] }),
    loadPoolConfigs: async () => [{ slots: [{ id: SLOT }] }],
  },
});
const commits = await import('../../run-lifecycle/validation-run-commits.js');
mock.module('../../run-lifecycle/validation-run-commits.js', {
  namedExports: {
    ...commits,
    restoreSlotParkedWork: async () => ({ branch: 'restored', head: 'a'.repeat(40) }),
    retainSlotParkedWork: async () => undefined,
  },
});
const release = await import('./release.js');
mock.module('./release.js', {
  namedExports: { ...release, assertReleaseRunGuards: () => undefined },
});
const tracking = await import('./slot-tracking.js');
mock.module('./slot-tracking.js', {
  namedExports: {
    ...tracking,
    assertSlotNotOperatorRoot: async () => duringCheck(),
  },
});
const workspace = await import('./workspace.js');
mock.module('./workspace.js', {
  namedExports: {
    ...workspace,
    inspectSlotWorkspace: async () => ({
      epoch: 1,
      branch: 'main',
      headSha: 'b'.repeat(40),
      dirtyFingerprint: 'clean',
      currentRunId: null,
      cleanupRunId: null,
      handoffRunId: null,
      recoveryId: null,
    }),
    invalidateSlotWorkspaceObservations: () => undefined,
    workspaceProtectedReason: async () => {
      duringCheck();
      return null;
    },
  },
});
mock.module('./idle-remote-prune.js', {
  namedExports: {
    pruneSlotRemoteRefs: async (slotId: string) =>
      events.push(
        `remote prune ${slotId}, guard ${activePrepareSlots.has(SLOT) ? 'held' : 'free'}`,
      ),
  },
});
const { slotParked } = await import('./parked.js');
const { parkedWorkRetentionPass } = await import('../../run-lifecycle/parked-work-retention.js');

beforeEach(() => {
  events.length = 0;
  duringCheck = () => {};
  duringReady = () => {};
  fenceApplies = true;
  activePrepareSlots.delete(SLOT);
});

const restore = () =>
  slotParked({ slotId: SLOT, action: 'restore', ref: 'refs/farmslot/parked/x' }, () => {});

test('a parked restore frees the prepare guard before the slot reads ready', async () => {
  await restore();
  assert.deepEqual(events, ['releasing fence', 'ready, guard free']);
  assert.equal(activePrepareSlots.has(SLOT), false);
});

test('a parked restore keeps a guard a prepare took once the slot read ready', async () => {
  duringReady = () => activePrepareSlots.add(SLOT);
  await restore();
  assert.equal(activePrepareSlots.has(SLOT), true, "the prepare's guard stays");
});

test('a parked restore refuses a slot another holder guarded while it checked the root', async () => {
  duringCheck = () => activePrepareSlots.add(SLOT);
  await assert.rejects(restore(), /Slot is preparing or refreshing/);
  assert.deepEqual(events, []);
  assert.equal(activePrepareSlots.has(SLOT), true, "the other holder's guard stays");
});

test('parked-work retention frees the prepare guard before the slot reads ready', async () => {
  await parkedWorkRetentionPass();
  assert.deepEqual(events, [
    'releasing fence',
    `remote prune ${SLOT}, guard held`,
    'ready, guard free',
  ]);
  assert.equal(activePrepareSlots.has(SLOT), false);
});

test('a claim that commits between the guard and the fence keeps the remote prune out', async () => {
  // find-slot's claim checked the guard before this pass took it, then wrote the row.
  fenceApplies = false;
  await parkedWorkRetentionPass();
  assert.deepEqual(events, [], 'no fence, no prune, no restore');
  assert.equal(activePrepareSlots.has(SLOT), false);
});

test('parked-work retention skips a slot another holder guarded while it read the slot', async () => {
  duringCheck = () => activePrepareSlots.add(SLOT);
  await parkedWorkRetentionPass();
  assert.deepEqual(events, []);
  assert.equal(activePrepareSlots.has(SLOT), true, "the other holder's guard stays");
});
