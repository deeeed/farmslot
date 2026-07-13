import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cdpLive,
  selectSlot,
  slotSelectionScore,
  slotUnavailableReason,
} from '../../src/contracts/slot-selection.js';
import type { SlotStatus } from '../../src/contracts/slots.js';

function slot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'macwork',
    platform: 'ios',
    project: 'demo-farm',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
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

test('slotUnavailableReason covers every dispatch blocker', () => {
  assert.equal(slotUnavailableReason(slot({ slot: 'a' })), null);
  assert.match(slotUnavailableReason(slot({ slot: 'a', missingFromPool: true })) ?? '', /ghost/u);
  assert.equal(slotUnavailableReason(slot({ slot: 'a', enabled: false })), 'disabled');
  assert.equal(slotUnavailableReason(slot({ slot: 'a', lifecycle: 'disabled' })), 'disabled');
  assert.equal(slotUnavailableReason(slot({ slot: 'a', lifecycle: 'manual' })), 'manual mode');
  assert.equal(slotUnavailableReason(slot({ slot: 'a', agent: 'working' })), 'agent working');
  assert.equal(
    slotUnavailableReason(slot({ slot: 'a', lifecycle: 'busy', phase: 'working' })),
    'lifecycle=busy (working)',
  );
  assert.equal(slotUnavailableReason(slot({ slot: 'a', dispatchable: false })), 'not dispatchable');
});

test('slotSelectionScore prefers live CDP, then device, then fixtures', () => {
  const perfect = slot({ slot: 'a' });
  const noCdp = slot({
    slot: 'b',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OFF', fixtures: 'OK' },
  });
  const noDevice = slot({
    slot: 'c',
    health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
  });
  const noFixtures = slot({
    slot: 'd',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: '2/3' },
  });
  assert.equal(slotSelectionScore(perfect), 0);
  assert.equal(slotSelectionScore(noCdp), 100);
  assert.equal(slotSelectionScore(noDevice), 5);
  assert.equal(slotSelectionScore(noFixtures), 1);
  assert.equal(cdpLive(noCdp), false);
});

test('selectSlot picks the best-scoring free slot for a project', () => {
  const result = selectSlot(
    [
      slot({
        slot: 'worse',
        health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'OFF', fixtures: 'OK' },
      }),
      slot({ slot: 'best' }),
      slot({ slot: 'busy-one', lifecycle: 'busy', phase: 'working' }),
      slot({ slot: 'other-project', project: 'elsewhere' }),
    ],
    { project: 'demo-farm' },
  );
  assert.ok(result.ok);
  assert.equal(result.slot.slot, 'best');
});

test('selectSlot reports a per-slot reason when everything is occupied', () => {
  const result = selectSlot(
    [
      slot({ slot: 'w1', agent: 'working' }),
      slot({ slot: 'w2', lifecycle: 'held', phase: 'pr-watch' }),
    ],
    { project: 'demo-farm' },
  );
  assert.ok(!result.ok);
  assert.match(result.reason, /occupied/u);
  assert.deepEqual(result.details, ['w1: agent working', 'w2: lifecycle=held (pr-watch)']);
});

test('selectSlot preferCdp narrows to CDP-live candidates when any exist', () => {
  const noCdpHealth = {
    ssh: 'LOCAL',
    device: 'sim:OK',
    devserver: 'OK',
    cdp: '-',
    fixtures: 'OK',
  };
  const result = selectSlot(
    [
      // Better score overall would be cdp-less with everything else equal —
      // preferCdp must still pick the live one.
      slot({ slot: 'no-cdp', health: noCdpHealth }),
      slot({
        slot: 'live-cdp',
        health: { ...noCdpHealth, cdp: 'Wallet', fixtures: '2/3' },
      }),
    ],
    { project: 'demo-farm', preferCdp: true },
  );
  assert.ok(result.ok);
  assert.equal(result.slot.slot, 'live-cdp');
});

test('selectSlot validate mode returns the named slot or its blocker', () => {
  const slots = [slot({ slot: 'target' }), slot({ slot: 'blocked', agent: 'working' })];
  const found = selectSlot(slots, { slotId: 'target' });
  assert.ok(found.ok);
  const blocked = selectSlot(slots, { slotId: 'blocked' });
  assert.ok(!blocked.ok);
  assert.match(blocked.reason, /agent working/u);
  const missing = selectSlot(slots, { slotId: 'ghost-9' });
  assert.ok(!missing.ok);
  assert.match(missing.reason, /not found/u);
});
