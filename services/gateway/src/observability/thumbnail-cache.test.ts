import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { shouldPollThumbnailForSlot } from './thumbnail-cache.js';

function makeSlot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'runner-mobile-1',
    machine: 'runner-local',
    platform: 'ios',
    project: 'example-mobile-farm',
    health: { ssh: 'LOCAL', device: 'sim:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'busy',
    phase: 'working',
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: 'run-active',
    currentFlowType: 'validation',
    currentTicketOrPr: 'PROJ-1',
    currentMode: 'validation',
    currentFamilyId: 'run-active',
    currentLane: 'validation',
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'codex',
    model: 'gpt-5.4',
    deviceName: 'mm-1',
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

test('shouldPollThumbnailForSlot requires an active slot lifecycle', () => {
  assert.equal(shouldPollThumbnailForSlot(makeSlot({ lifecycle: 'busy' })), true);
  assert.equal(shouldPollThumbnailForSlot(makeSlot({ lifecycle: 'held' })), true);
  assert.equal(shouldPollThumbnailForSlot(makeSlot({ lifecycle: 'ready', phase: null })), false);
  assert.equal(
    shouldPollThumbnailForSlot(makeSlot({ lifecycle: 'busy', currentRunId: null })),
    false,
  );
});

test('shouldPollThumbnailForSlot skips disabled and offline-device slots', () => {
  assert.equal(shouldPollThumbnailForSlot(makeSlot({ lifecycle: 'disabled' })), false);
  assert.equal(
    shouldPollThumbnailForSlot(
      makeSlot({
        health: { ssh: 'LOCAL', device: 'sim:OFF', devserver: 'OFF', cdp: '-', fixtures: 'OK' },
      }),
    ),
    false,
  );
});
