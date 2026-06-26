import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskProgressStructured } from '@farmslot/protocol';

import {
  progressFingerprint,
  reconcileFinalStepFromSignal,
  reconcileProgressFromChecklistTiming,
} from './task.js';

function makeStructured(done: number): TaskProgressStructured {
  return {
    schema: {
      flowType: 'fix-bug',
      title: 'Task',
      phases: [
        {
          name: 'Work',
          steps: [
            { index: 1, name: 'Step 1' },
            { index: 2, name: 'Step 2' },
            { index: 3, name: 'Write signal' },
          ],
        },
      ],
      totalSteps: 3,
    },
    phases: [
      {
        name: 'Work',
        steps: [
          { index: 1, name: 'Step 1', status: done >= 1 ? 'done' : 'running' },
          {
            index: 2,
            name: 'Step 2',
            status: done >= 2 ? 'done' : done === 1 ? 'running' : 'pending',
          },
          { index: 3, name: 'Write signal', status: done >= 3 ? 'done' : 'pending' },
        ],
        completedSteps: done,
        totalSteps: 3,
      },
    ],
    completedSteps: done,
    totalSteps: 3,
    currentPhase: done >= 3 ? null : 'Work',
    currentStep: done === 0 ? 'Step 1' : done === 1 ? 'Step 2' : 'Write signal',
  };
}

test('reconcileFinalStepFromSignal bumps N-1/N completed task to done', () => {
  const structured = makeStructured(2);
  reconcileFinalStepFromSignal(structured);

  assert.equal(structured.completedSteps, 3);
  assert.equal(structured.phases[0].completedSteps, 3);
  assert.equal(structured.phases[0].steps[2].status, 'done');
  assert.equal(structured.currentPhase, null);
  assert.equal(structured.currentStep, null);
});

test('reconcileFinalStepFromSignal leaves N-2/N task unchanged', () => {
  const structured = makeStructured(1);
  reconcileFinalStepFromSignal(structured);

  assert.equal(structured.completedSteps, 1);
  assert.equal(structured.phases[0].completedSteps, 1);
  assert.equal(structured.phases[0].steps[1].status, 'running');
  assert.equal(structured.phases[0].steps[2].status, 'pending');
  assert.equal(structured.currentPhase, 'Work');
  assert.equal(structured.currentStep, 'Step 2');
});

test('reconcileProgressFromChecklistTiming marks steps done from signal events', () => {
  const structured = makeStructured(0);
  reconcileProgressFromChecklistTiming(structured, {
    schemaVersion: 1,
    source: 'TASK.md',
    events: [
      { stepNumber: 1, label: 'Step 1', checkedAt: '2026-06-26T10:00:00Z' },
      { stepNumber: 2, label: 'Step 2', checkedAt: '2026-06-26T10:01:00Z' },
    ],
  });

  assert.equal(structured.completedSteps, 2);
  assert.equal(structured.phases[0].steps[0].status, 'done');
  assert.equal(structured.phases[0].steps[1].status, 'done');
  assert.equal(structured.phases[0].steps[2].status, 'running');
  assert.equal(structured.currentPhase, 'Work');
  assert.equal(structured.currentStep, 'Write signal');
});

test('progressFingerprint changes when checklistTiming events change without markdown edits', () => {
  const markdown = '- [ ] one\n- [ ] two\n';
  const before = progressFingerprint(markdown, {
    checklistTiming: {
      schemaVersion: 1,
      events: [{ stepNumber: 1, label: 'one', checkedAt: '2026-06-26T10:00:00Z' }],
    },
  });
  const after = progressFingerprint(markdown, {
    checklistTiming: {
      schemaVersion: 1,
      events: [
        { stepNumber: 1, label: 'one', checkedAt: '2026-06-26T10:00:00Z' },
        { stepNumber: 2, label: 'two', checkedAt: '2026-06-26T10:01:00Z' },
      ],
    },
  });
  assert.notEqual(before, after);
});
