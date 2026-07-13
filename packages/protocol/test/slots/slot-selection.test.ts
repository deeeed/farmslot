import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cdpLive,
  explicitSlotBlocker,
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

test('slotUnavailableReason blocks dispatch states but not degraded health', () => {
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
  // Degraded health is a scoring concern, not an availability blocker —
  // mirrors gateway isFreeSlot (SlotStatus.dispatchable encodes health, so
  // gating on it would report "occupied" for slots dispatch would accept).
  assert.equal(
    slotUnavailableReason(
      slot({
        slot: 'a',
        dispatchable: false,
        health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: '-', cdp: 'OFF', fixtures: '-' },
      }),
    ),
    null,
  );
});

test('explicitSlotBlocker allows held slots for deliberate reuse', () => {
  assert.equal(
    explicitSlotBlocker(slot({ slot: 'a', lifecycle: 'held', phase: 'pr-watch' })),
    null,
  );
  assert.equal(explicitSlotBlocker(slot({ slot: 'a' })), null);
  assert.equal(
    explicitSlotBlocker(slot({ slot: 'a', lifecycle: 'busy', phase: 'dispatching' })),
    'busy (dispatching)',
  );
  assert.equal(explicitSlotBlocker(slot({ slot: 'a', agent: 'working' })), 'agent working');
  assert.equal(explicitSlotBlocker(slot({ slot: 'a', lifecycle: 'manual' })), 'manual mode');
  assert.match(explicitSlotBlocker(slot({ slot: 'a', missingFromPool: true })) ?? '', /ghost/u);
});

test('slotSelectionScore prefers live CDP, then warm, then device, then fixtures', () => {
  const perfect = slot({ slot: 'a' });
  const noCdp = slot({
    slot: 'b',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'OFF', fixtures: 'OK' },
  });
  const cold = slot({ slot: 'c', warm: false });
  const noDevice = slot({
    slot: 'd',
    health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
  });
  const noFixtures = slot({
    slot: 'e',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: '2/3' },
  });
  assert.equal(slotSelectionScore(perfect), 0);
  assert.equal(slotSelectionScore(noCdp), 100);
  assert.equal(slotSelectionScore(cold), 10);
  assert.equal(slotSelectionScore(noDevice), 5);
  assert.equal(slotSelectionScore(noFixtures), 1);
  assert.equal(cdpLive(noCdp), false);
  // CDP dominates every other penalty combined (10 + 5 + 1 < 100), so a
  // live-CDP slot always outranks a CDP-less one — no prefer-CDP filter needed.
  const degradedButLive = slot({
    slot: 'f',
    warm: false,
    health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OK', cdp: 'Wallet', fixtures: '-' },
  });
  assert.ok(slotSelectionScore(degradedButLive) < slotSelectionScore(noCdp));
});

test('selectSlot picks the best-scoring free slot for a project', () => {
  const result = selectSlot(
    [
      slot({
        slot: 'worse',
        warm: false,
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

test('selectSlot failure codes discriminate not-found from occupied', () => {
  const occupied = selectSlot(
    [
      slot({ slot: 'w1', agent: 'working' }),
      slot({ slot: 'w2', lifecycle: 'held', phase: 'pr-watch' }),
    ],
    { project: 'demo-farm' },
  );
  assert.ok(!occupied.ok);
  assert.equal(occupied.code, 'NO_SLOT_AVAILABLE');
  assert.match(occupied.reason, /occupied/u);
  assert.deepEqual(occupied.details, ['w1: agent working', 'w2: lifecycle=held (pr-watch)']);

  const noProject = selectSlot([slot({ slot: 'a' })], { project: 'nope' });
  assert.ok(!noProject.ok);
  assert.equal(noProject.code, 'PROJECT_NOT_FOUND');
});

test('selectSlot validate mode uses the explicit-slot predicate', () => {
  const slots = [
    slot({ slot: 'target', lifecycle: 'held', phase: 'pr-watch' }),
    slot({ slot: 'blocked', agent: 'working' }),
  ];
  // Held is selectable when named explicitly (PR affinity reuse) …
  const held = selectSlot(slots, { slotId: 'target' });
  assert.ok(held.ok);
  // … but never auto-selected.
  const auto = selectSlot(slots, { project: 'demo-farm' });
  assert.ok(!auto.ok);

  const blocked = selectSlot(slots, { slotId: 'blocked' });
  assert.ok(!blocked.ok);
  assert.equal(blocked.code, 'SLOT_UNAVAILABLE');
  assert.match(blocked.reason, /agent working/u);

  const missing = selectSlot(slots, { slotId: 'ghost-9' });
  assert.ok(!missing.ok);
  assert.equal(missing.code, 'SLOT_NOT_FOUND');
});
