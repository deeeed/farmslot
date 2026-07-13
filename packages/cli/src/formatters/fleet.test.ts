import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, FleetStatusResult, SlotStatus } from '@farmslot/protocol';

import { formatFleetStatus } from './fleet.js';

function slotFixture(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'macwork',
    platform: 'ios',
    project: 'farmslot-farm',
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: false,
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
  } as SlotStatus;
}

function resultFixture(fleet: Partial<FleetStatus> & { slots: SlotStatus[] }): FleetStatusResult {
  return {
    fleet: {
      checkedAt: new Date().toISOString(),
      summary: {
        total: fleet.slots.length,
        ready: fleet.slots.length,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
      ...fleet,
    },
  };
}

test('fresh status suggests prepare for live cold slots', () => {
  const output = formatFleetStatus(
    resultFixture({ slots: [slotFixture({ slot: 'macwork-ff-1', warm: false })] }),
  );
  assert.match(output, /farmslot slot prepare macwork-ff-1/u);
  assert.doesNotMatch(output, /STALE STATUS/u);
});

test('stale status shows a banner and suppresses every prepare/dispatch hint', () => {
  const output = formatFleetStatus(
    resultFixture({
      checkedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      stale: true,
      slots: [
        slotFixture({ slot: 'macwork-ff-1', warm: false }),
        slotFixture({ slot: 'ghost-slot-9', warm: false, missingFromPool: true }),
      ],
    }),
  );
  assert.match(output, /STALE STATUS/u);
  assert.match(output, /--force-refresh/u);
  assert.doesNotMatch(output, /farmslot slot prepare/u);
  assert.doesNotMatch(output, /farmslot run create/u);
});

test('ghost slots absent from live pools never receive prepare hints even when fresh', () => {
  const output = formatFleetStatus(
    resultFixture({
      slots: [
        slotFixture({ slot: 'macwork-ff-1', warm: false }),
        slotFixture({ slot: 'ghost-slot-9', warm: false, missingFromPool: true }),
      ],
    }),
  );
  assert.match(output, /farmslot slot prepare macwork-ff-1/u);
  assert.doesNotMatch(output, /farmslot slot prepare ghost-slot-9/u);
});
