import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus, SlotWorkspace } from '@farmslot/protocol';

import {
  FLEET_RELEASE_LABEL,
  fleetReleaseScope,
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

test('with no selection the bulk action reviews every visible slot', () => {
  const scope = fleetReleaseScope([idle, idle2, busy], new Set());
  assert.deepEqual(scope.slotIds, ['idle-1', 'idle-2', 'busy-1']);
  assert.equal(scope.label, `${FLEET_RELEASE_LABEL} (2)`);
  assert.equal(scope.eligible, true);
  assert.equal(scope.disabled, false);
});

test('a selection narrows the bulk action to the chosen visible rows', () => {
  const scope = fleetReleaseScope([idle, idle2, busy], new Set(['idle-2', 'gone']));
  assert.deepEqual(scope.slotIds, ['idle-2']);
  assert.equal(scope.label, `${FLEET_RELEASE_LABEL} (1 selected)`);
  assert.equal(scope.disabled, false);
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
