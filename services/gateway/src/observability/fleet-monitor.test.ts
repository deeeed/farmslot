import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

import { detectFleetMonitorViolations } from './fleet-monitor.js';

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
    phase: null,
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

test('detectFleetMonitorViolations emits idle once until the slot recovers', () => {
  const notified = new Set<string>();
  const busyIdle = fleet([slot({ lifecycle: 'busy', phase: 'working', agent: 'idle' })]);
  const readyIdle = fleet([slot({ lifecycle: 'ready', agent: 'idle' })]);

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

test('detectFleetMonitorViolations does not flag expected idle lifecycle phases', () => {
  for (const phase of ['preparing', 'dispatching', 'review-gate'] as const) {
    assert.deepEqual(
      detectFleetMonitorViolations(
        fleet([slot({ lifecycle: 'busy', phase, agent: 'idle' })]),
        new Set<string>(),
      ),
      [],
      `${phase} should allow an idle runner`,
    );
  }
});

test('detectFleetMonitorViolations trusts an active structured agent context', () => {
  const busyIdle = slot({
    lifecycle: 'busy',
    phase: 'working',
    agent: 'idle',
    currentRunId: 'run-1',
    agentContexts: [
      {
        id: 'ci-fix',
        role: 'ci-fix',
        label: 'CI fix',
        status: 'working',
        runId: 'run-1',
        lastSignalAt: '2026-04-25T00:00:00Z',
      },
    ],
  });

  assert.deepEqual(
    detectFleetMonitorViolations(
      fleet([busyIdle]),
      new Set<string>(),
      () => '2026-04-25T00:01:00Z',
    ),
    [],
  );
});

test('detectFleetMonitorViolations rejects stale or foreign structured contexts', () => {
  const activeContext = {
    id: 'ci-fix',
    role: 'ci-fix' as const,
    label: 'CI fix',
    status: 'working' as const,
    runId: 'run-1',
    lastSignalAt: '2026-04-25T00:00:00Z',
  };
  const base = {
    lifecycle: 'busy' as const,
    phase: 'working' as const,
    agent: 'idle' as const,
    currentRunId: 'run-1',
  };

  for (const { candidate, observedAt } of [
    {
      candidate: slot({ ...base, currentRunId: 'run-2', agentContexts: [activeContext] }),
      observedAt: '2026-04-25T00:01:00Z',
    },
    {
      candidate: slot({ ...base, agentContexts: [activeContext] }),
      observedAt: '2026-04-25T00:06:00Z',
    },
  ]) {
    assert.deepEqual(
      detectFleetMonitorViolations(fleet([candidate]), new Set<string>(), () => observedAt).map(
        (violation) => violation.type,
      ),
      ['idle'],
    );
  }
});

test('detectFleetMonitorViolations dedupes stuck and idle independently', () => {
  const notified = new Set<string>();
  const noTmux = fleet([slot({ lifecycle: 'busy', agent: 'no-tmux' })]);
  const idle = fleet([slot({ lifecycle: 'busy', phase: 'working', agent: 'idle' })]);

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
