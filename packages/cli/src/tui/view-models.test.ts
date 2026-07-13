import assert from 'node:assert/strict';
import test from 'node:test';

import type { BacklogItem, FleetStatus, Run, SlotStatus } from '@farmslot/protocol';

import { backlogViewModel, diagnoseFleet, fleetViewModel, runsViewModel } from './view-models.js';

function slot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'macwork',
    platform: 'ios',
    project: 'farmslot-farm',
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
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
  } as SlotStatus;
}

function fleet(overrides: Partial<FleetStatus> & { slots: SlotStatus[] }): FleetStatus {
  return {
    checkedAt: new Date().toISOString(),
    summary: {
      total: overrides.slots.length,
      ready: overrides.slots.length,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    ...overrides,
  };
}

test('fleetViewModel hides disabled slots, marks ghosts undispatchable, and carries stale', () => {
  const vm = fleetViewModel(
    fleet({
      stale: true,
      slots: [
        slot({ slot: 'live-1' }),
        slot({ slot: 'ghost-1', missingFromPool: true, dispatchable: false }),
        slot({ slot: 'off-1', lifecycle: 'disabled' }),
      ],
    }),
  );
  assert.equal(vm.stale, true);
  assert.deepEqual(
    vm.rows.map((row) => row.slot),
    ['live-1', 'ghost-1'],
  );
  assert.equal(vm.rows[1].ghost, true);
  assert.equal(vm.rows[1].dispatchable, false);
});

test('backlogViewModel sorts by priority and derives loop actions from status', () => {
  const items = [
    {
      id: 'b',
      sourceRef: 'MANUAL-2',
      status: 'done',
      priority: 1,
      project: 'p',
      title: 'done item',
    },
    {
      id: 'a',
      sourceRef: 'MANUAL-1',
      status: 'candidate',
      priority: 2,
      project: 'p',
      title: 'todo',
    },
  ] as unknown as BacklogItem[];
  const vm = backlogViewModel(items);
  assert.deepEqual(
    vm.map((row) => row.ref),
    ['MANUAL-2', 'MANUAL-1'],
  );
  assert.equal(vm[0].canDispatch, false);
  assert.equal(vm[0].canCloseShipped, false);
  assert.equal(vm[1].canDispatch, true);
  assert.equal(vm[1].canCloseShipped, true);
});

test('runsViewModel surfaces pending gate decisions with their action ids', () => {
  const runs = [
    {
      id: 'run-1234-5678',
      status: 'human-gating',
      flowType: 'dev',
      ticketOrPr: 'MANUAL-000018',
      slotId: 'macwork-ff-2',
      decisions: [
        {
          id: 'gate-1',
          title: 'gate',
          actions: [{ id: 'approve-publish' }, { id: 'close-as-shipped' }],
        },
        { id: 'gate-0', title: 'old', resolvedAt: 'x', actions: [] },
      ],
    },
  ] as unknown as Run[];
  const vm = runsViewModel(runs);
  assert.equal(vm[0].pendingDecisions.length, 1);
  assert.deepEqual(vm[0].pendingDecisions[0].actions, ['approve-publish', 'close-as-shipped']);
});

test('diagnoseFleet classifies empty-pool, stale, ghost, and healthy states', () => {
  assert.equal(diagnoseFleet(fleet({ slots: [] })).kind, 'empty-pool');
  assert.equal(
    diagnoseFleet(fleet({ slots: [slot({ slot: 'g', missingFromPool: true })] })).kind,
    'empty-pool',
  );
  assert.equal(
    diagnoseFleet(fleet({ stale: true, slots: [slot({ slot: 'a' })] })).kind,
    'stale-status',
  );
  const ghosts = diagnoseFleet(
    fleet({ slots: [slot({ slot: 'a' }), slot({ slot: 'g', missingFromPool: true })] }),
  );
  assert.equal(ghosts.kind, 'ghost-slots');
  assert.match(ghosts.nextCommands.join(' '), /fleet refresh/u);
  assert.equal(diagnoseFleet(fleet({ slots: [slot({ slot: 'a' })] })).kind, 'healthy');
});
