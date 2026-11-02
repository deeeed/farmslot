import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus, SlotWorkspace } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { FleetRefreshViewModel } from '@farmslot/review-dispatch';

import {
  FLEET_RELEASE_LABEL,
  fleetLocalWorkNote,
  fleetReleaseScope,
  pruneFleetSelection,
  setFleetSelection,
} from './fleet-release-scope.js';

const now = new Date().toISOString();

function workspace(branch: string): SlotWorkspace {
  return {
    epoch: 1,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    branch,
    headSha: 'abc',
    dirtyFingerprint: '',
    recoveryId: null,
    observedAt: now,
    localDefaultSha: 'abc',
    defaultFetchedAt: now,
    remoteDefaultSha: 'def',
    remoteObservedAt: now,
    behind: 2,
    remoteAdvanced: false,
    publication: 'pushed',
    dirtyCount: 0,
    unpublishedCount: 0,
  };
}

function slot(id: string, overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: id,
    machine: 'runner-a',
    project: 'demo',
    branch: 'feat/x',
    enabled: true,
    lifecycle: 'ready',
    phase: null,
    currentRunId: '',
    agent: 'idle',
    health: { ssh: 'LOCAL', device: '-', devserver: '-', cdp: '-', fixtures: 'OK' },
    workspace: workspace('feat/x'),
    ...overrides,
  } as SlotStatus;
}

const idle = slot('idle-1');
const idle2 = slot('idle-2');
const busy = slot('busy-1', { lifecycle: 'busy', agent: 'working', currentRunId: 'run-1' });

test('with nothing selected the bulk action is disabled and says so', () => {
  const scope = fleetReleaseScope([idle, idle2, busy], new Set());
  assert.deepEqual(scope.slotIds, []);
  assert.equal(scope.label, FLEET_RELEASE_LABEL);
  assert.equal(scope.disabled, true);
  assert.equal(scope.title, 'Select slots to release');
  assert.equal(
    scope.reason,
    'Select slots to release',
    'shown beside the button, not only on hover',
  );
});

test('a selection narrows the bulk action to the chosen visible rows', () => {
  const scope = fleetReleaseScope([idle, idle2, busy], new Set(['idle-2']));
  assert.deepEqual(scope.slotIds, ['idle-2']);
  assert.equal(scope.label, `${FLEET_RELEASE_LABEL} (1 selected)`);
  assert.equal(scope.disabled, false);
  assert.equal(scope.reason, '');
});

test('a filter that hides the selection disables the action instead of widening it', () => {
  // Search now shows only idle-1 and busy-1; idle-2 stays selected but hidden.
  const scope = fleetReleaseScope([idle, busy], new Set(['idle-2']));
  assert.deepEqual(scope.slotIds, []);
  assert.equal(scope.disabled, true);
  assert.equal(scope.title, 'The selected slots are hidden by the current filters');
  assert.equal(scope.reason, 'Selection hidden by filters');
});

test('cards and the resource view have no rows to select', () => {
  const scope = fleetReleaseScope([idle, idle2], new Set(['idle-1']), false);
  assert.equal(scope.disabled, true);
  assert.equal(scope.title, 'Switch to the table to select slots to release');
});

test('selected ids that left the fleet are pruned; an unchanged selection keeps its identity', () => {
  const selected = new Set(['idle-1', 'gone']);
  assert.deepEqual([...pruneFleetSelection(selected, [idle, idle2])], ['idle-1']);
  const kept = new Set(['idle-1']);
  assert.equal(pruneFleetSelection(kept, [idle, idle2]), kept);
});

test('a selection of busy slots cannot open the release review', () => {
  const scope = fleetReleaseScope([idle, busy], new Set(['busy-1']));
  assert.deepEqual(scope.slotIds, ['busy-1']);
  assert.equal(scope.eligible, false);
  assert.equal(scope.disabled, true);
  assert.match(scope.title, /No selected slot can be released/);
});

test('selection toggles whole groups and single rows without mutating the old set', () => {
  const before = new Set(['a']);
  const all = setFleetSelection(before, ['a', 'b', 'c'], true);
  assert.deepEqual([...all], ['a', 'b', 'c']);
  assert.deepEqual([...before], ['a']);
  assert.deepEqual([...setFleetSelection(all, ['b'], false)], ['a', 'c']);
  assert.deepEqual([...setFleetSelection(all, ['a', 'b', 'c'], false)], []);
});

test('the bulk release sends exactly the selected safe slots to fleet.refreshSlots', async () => {
  const unpushed = slot('unpushed-1', {
    workspace: { ...workspace('feat/x'), publication: 'unpushed', unpublishedCount: 1 },
  });
  const fleet = [idle, idle2, busy, unpushed];
  const scope = fleetReleaseScope(fleet, new Set(['idle-2', 'busy-1', 'unpushed-1']));
  const calls: Array<{ method: string; params: unknown }> = [];
  const model = new FleetRefreshViewModel(
    {
      contextKey: () => 'farm',
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        const reply =
          method === Methods.FLEET_STATUS
            ? { fleet: { slots: fleet } }
            : { requestId: 'bulk-1', perSlotRequestIds: {} };
        return reply as T;
      },
      subscribe: () => () => {},
    },
    () => 'bulk-1',
  );
  await model.load(scope.slotIds, fleet);
  assert.deepEqual(
    model.rows.map((row) => row.slotId),
    ['idle-2', 'busy-1', 'unpushed-1'],
  );
  assert.equal(
    fleetLocalWorkNote(model.rows),
    'Unpushed or uncommitted work on unpushed-1. Bulk release skips it.',
  );
  await model.releaseIdle();
  const bulk = calls.filter((call) => call.method === Methods.FLEET_REFRESH_SLOTS);
  assert.equal(bulk.length, 1);
  const { slots } = bulk[0].params as { slots: Array<{ slotId: string; mode: string }> };
  assert.deepEqual(
    slots.map((target) => [target.slotId, target.mode]),
    [['idle-2', 'safe']],
    'busy and unpushed rows stay out of bulk; idle-1 was not selected',
  );
  model.dispose();
});
