import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskProgressStructured } from '@farmslot/protocol';

import { generateTaskSchema } from '../tasks/writer.js';

import { joinSchemaWithMarkdown, reconcileFinalStepFromSignal } from './task.js';

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

test('interactive CHECKLIST.md parses into structured monitor progress', () => {
  const markdown = [
    '# Interactive Dev Checklist',
    '',
    '- [x] Clarify the target outcome with the operator',
    '- [ ] Implement the smallest useful change on the selected branch',
    '- [ ] Run focused validation or capture why validation was skipped',
    '- [ ] Choose an interactive completion action in Farmslot',
    '',
  ].join('\n');
  const schema = generateTaskSchema(markdown, 'dev');
  assert.equal(schema.totalSteps, 4);
  const structured = joinSchemaWithMarkdown(schema, markdown);
  assert.equal(structured.completedSteps, 1);
  assert.equal(structured.totalSteps, 4);
  assert.equal(structured.currentStep, 'Implement the smallest useful change on the selected branch');
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
