import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import {
  computeSummary,
  type FleetStatus,
  type SlotCheckParams,
  type SlotStatus,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const actualFleet = await import('../../fleet/state.js');
const actualSources = await import('../../sources/runtime.js');

let owner: string | null = 'owned-run';
let reservedOwner: 'cleanupRunId' | 'handoffRunId' | undefined;
let phase: SlotStatus['phase'] = 'working';
let sourceActivations = 0;
const sourceReached = new Error('source activation reached');

function fleet(): FleetStatus {
  const slot: SlotStatus = {
    slot: 'mobile-fixture',
    machine: 'fixture',
    platform: 'ios',
    project: 'fixture',
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: owner ? 'working' : 'idle',
    enabled: true,
    dispatchable: !owner && !reservedOwner,
    lifecycle: owner ? 'busy' : reservedOwner ? 'held' : 'ready',
    phase: owner ? phase : reservedOwner ? 'occupied' : null,
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: owner,
    cleanupRunId: reservedOwner === 'cleanupRunId' ? 'owned-run' : null,
    handoffRunId: reservedOwner === 'handoffRunId' ? 'owned-run' : null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
  return { checkedAt: new Date().toISOString(), slots: [slot], summary: computeSummary([slot]) };
}

mock.module('../../fleet/state.js', {
  namedExports: { ...actualFleet, loadFleetStatus: async () => fleet() },
});
mock.module('../../sources/runtime.js', {
  namedExports: {
    ...actualSources,
    withSlotSources: async () => {
      sourceActivations++;
      throw sourceReached;
    },
  },
});
const { slotCheck } = await import('./check.js');

beforeEach(() => {
  owner = 'owned-run';
  reservedOwner = undefined;
  phase = 'working';
  sourceActivations = 0;
});

for (const activePhase of ['preparing', 'working'] as const) {
  test(`slot check refuses a ${activePhase} owner before source activation`, async () => {
    phase = activePhase;
    await assert.rejects(
      slotCheck({ slotId: 'mobile-fixture' }, () => {}),
      /owned-run.*--force/,
    );
    assert.equal(sourceActivations, 0, 'Refusal must precede source sync and all health hooks');
  });
}

for (const reservation of ['cleanupRunId', 'handoffRunId'] as const) {
  test(`slot check refuses a ${reservation} before source activation`, async () => {
    owner = null;
    reservedOwner = reservation;
    await assert.rejects(
      slotCheck({ slotId: 'mobile-fixture' }, () => {}),
      /owned-run.*--force/,
    );
    assert.equal(sourceActivations, 0);
  });
}

test('explicit force reaches the existing slot check path while owned', async () => {
  const request: SlotCheckParams & { force: boolean } = { slotId: 'mobile-fixture', force: true };
  await assert.rejects(
    slotCheck(request, () => {}),
    (error) => error === sourceReached,
  );
  assert.equal(sourceActivations, 1);
});

test('force false does not bypass the owner refusal', async () => {
  const request: SlotCheckParams & { force: boolean } = { slotId: 'mobile-fixture', force: false };
  await assert.rejects(
    slotCheck(request, () => {}),
    /owned-run.*--force/,
  );
  assert.equal(sourceActivations, 0);
});

test('an idle slot keeps the existing check path', async () => {
  owner = null;
  await assert.rejects(
    slotCheck({ slotId: 'mobile-fixture' }, () => {}),
    (error) => error === sourceReached,
  );
  assert.equal(sourceActivations, 1);
});
