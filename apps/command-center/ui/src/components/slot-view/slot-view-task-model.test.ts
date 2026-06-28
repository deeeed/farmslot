import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import {
  formatSlotViewDuration,
  hasSlotViewActiveTask,
  shouldShowSlotViewTaskUi,
} from './slot-view-task-model.js';

function makeSlot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'runner-local-1',
    machine: 'runner-local',
    platform: 'darwin',
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
  };
}

test('formatSlotViewDuration formats seconds and minute durations', () => {
  assert.equal(formatSlotViewDuration(10_400), '10s');
  assert.equal(formatSlotViewDuration(60_000), '1m');
  assert.equal(formatSlotViewDuration(125_000), '2m 5s');
});

test('hasSlotViewActiveTask detects structured progress or parsed steps', () => {
  assert.equal(hasSlotViewActiveTask(undefined, []), false);
  assert.equal(hasSlotViewActiveTask(undefined, [{ text: 'Do it', checked: false }]), true);
  assert.equal(
    hasSlotViewActiveTask(
      {
        schema: { flowType: 'fixbug', title: 'Fix bug', totalSteps: 0, phases: [] },
        phases: [],
        completedSteps: 0,
        totalSteps: 0,
        currentPhase: null,
        currentStep: null,
      },
      [],
    ),
    true,
  );
});

test('shouldShowSlotViewTaskUi requires a task file and active task context', () => {
  assert.equal(shouldShowSlotViewTaskUi(null, undefined, []), false);
  assert.equal(shouldShowSlotViewTaskUi(makeSlot({ lifecycle: 'busy' }), undefined, []), false);
  assert.equal(
    shouldShowSlotViewTaskUi(
      makeSlot({ taskFile: 'tasks/demo.md', lifecycle: 'busy' }),
      undefined,
      [],
    ),
    true,
  );
  assert.equal(
    shouldShowSlotViewTaskUi(
      makeSlot({ taskFile: 'tasks/demo.md', phase: 'ci-watch' }),
      undefined,
      [],
    ),
    true,
  );
  assert.equal(
    shouldShowSlotViewTaskUi(
      makeSlot({ taskFile: 'tasks/demo.md', lifecycle: 'ready' }),
      undefined,
      [{ text: 'Do it', checked: false }],
    ),
    true,
  );
});
