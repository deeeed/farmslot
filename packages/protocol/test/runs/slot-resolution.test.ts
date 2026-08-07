import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import { resolveRunSlotId } from '../../src/runs/slot-resolution.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-a',
    lane: 'production',
    flowType: 'dev',
    status: 'preparing',
    project: 'project-a',
    ticketOrPr: 'BUG-1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'grok', model: 'grok-build', durationMs: 0 },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Run;
}

test('resolveRunSlotId prefers top-level slotId', () => {
  assert.equal(resolveRunSlotId(run({ slotId: 'macwork-ff-4' })), 'macwork-ff-4');
});

test('resolveRunSlotId falls back to find-slot selectedSlot', () => {
  assert.equal(
    resolveRunSlotId(
      run({
        slotId: null,
        steps: [
          {
            name: 'find-slot',
            status: 'done',
            outputs: { selectedSlot: 'macwork-ff-4' },
          },
        ],
      }),
    ),
    'macwork-ff-4',
  );
});

test('resolveRunSlotId prefers agent context over find-slot output', () => {
  assert.equal(
    resolveRunSlotId(
      run({
        slotId: null,
        agentContexts: [{ role: 'dev', slotId: 'macwork-ff-3', status: 'working' }],
        steps: [
          {
            name: 'find-slot',
            status: 'done',
            outputs: { selectedSlot: 'macwork-ff-4' },
          },
        ],
      }),
    ),
    'macwork-ff-3',
  );
});
