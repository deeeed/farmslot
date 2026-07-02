import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

import { detectFleetMonitorViolations } from './fleet-monitor.js';
import { isWorkerMonitorPhase } from './worker-monitor-phase.js';

function slot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'runner-browser-2',
    machine: 'runner-local',
    platform: 'chrome-extension',
    project: 'example-browser-farm',
    health: { ssh: 'LOCAL', device: 'ext:OK', devserver: 'OFF', cdp: 'OK', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'busy',
    phase: 'working',
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    currentMode: null,
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: '',
    taskPhase: null,
    taskStepProgress: null,
    resourceRollup: 'none',
    ...overrides,
  } as SlotStatus;
}

function fleet(slots: SlotStatus[]): FleetStatus {
  return {
    checkedAt: '2026-04-25T00:00:00Z',
    slots,
    summary: {
      total: slots.length,
      ready: 0,
      busy: slots.length,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    machines: [],
  };
}

test('isWorkerMonitorPhase is true only for busy/working slots', () => {
  assert.equal(isWorkerMonitorPhase({ lifecycle: 'busy', phase: 'working' }), true);
  assert.equal(isWorkerMonitorPhase({ lifecycle: 'busy', phase: 'preparing' }), false);
  assert.equal(isWorkerMonitorPhase({ lifecycle: 'busy', phase: 'dispatching' }), false);
  assert.equal(isWorkerMonitorPhase({ lifecycle: 'ready', phase: null }), false);
});

test('detectFleetMonitorViolations emits idle once until the slot recovers', () => {
  const notified = new Set<string>();
  const busyIdle = fleet([slot({ lifecycle: 'busy', agent: 'idle', phase: 'working' })]);
  const readyIdle = fleet([slot({ lifecycle: 'ready', agent: 'idle', phase: null })]);

  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:01Z').map(
      (v) => v.type,
    ),
    ['idle'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:02Z').map(
      (v) => v.type,
    ),
    [],
  );

  assert.deepEqual(
    detectFleetMonitorViolations(readyIdle, notified).map((v) => v.type),
    [],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(busyIdle, notified, () => '2026-04-25T00:00:03Z').map(
      (v) => v.type,
    ),
    ['idle'],
  );
});

test('detectFleetMonitorViolations ignores orchestration busy+idle (grade/prepare/dispatch)', () => {
  const notified = new Set<string>();
  for (const phase of ['preparing', 'dispatching', 'review-gate', 'releasing', null] as const) {
    const orchestration = fleet([slot({ lifecycle: 'busy', agent: 'idle', phase: phase ?? null })]);
    assert.deepEqual(
      detectFleetMonitorViolations(orchestration, notified).map((v) => v.type),
      [],
      `expected no idle violation during phase=${String(phase)}`,
    );
  }
});

test('detectFleetMonitorViolations dedupes stuck and idle independently', () => {
  const notified = new Set<string>();
  const noTmux = fleet([slot({ lifecycle: 'busy', agent: 'no-tmux', phase: 'working' })]);
  const idle = fleet([slot({ lifecycle: 'busy', agent: 'idle', phase: 'working' })]);

  assert.deepEqual(
    detectFleetMonitorViolations(noTmux, notified).map((v) => v.type),
    ['stuck'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(noTmux, notified).map((v) => v.type),
    [],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(idle, notified).map((v) => v.type),
    ['idle'],
  );
  assert.deepEqual(
    detectFleetMonitorViolations(idle, notified).map((v) => v.type),
    [],
  );
});
