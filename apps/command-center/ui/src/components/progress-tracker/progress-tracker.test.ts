import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { TaskStepProgress, TaskStepSubtaskProgress } from '@farmslot/protocol';

import { litBinding, litText } from '../../testing/lit-text.js';

import { renderTrackerStepRow } from './progress-tracker.js';
import { SubtaskOpenState } from './subtask-block.js';

function childUnit(id = 'perps-review'): TaskStepSubtaskProgress {
  const steps = [
    { index: 1, name: 'Read the diff', status: 'done' as const },
    { index: 2, name: 'Run the recipe', status: 'running' as const },
  ];
  return {
    id,
    status: 'running',
    source: { kind: 'skill', ref: 'skills/review/skill.md', sha256: 'a', renderedSha256: 'b' },
    progress: {
      schema: {
        flowType: 'subtask',
        title: id,
        totalSteps: 2,
        phases: [{ name: id, steps: steps.map(({ index, name }) => ({ index, name })) }],
      },
      phases: [{ name: id, steps, completedSteps: 1, totalSteps: 2 }],
      completedSteps: 1,
      totalSteps: 2,
      currentPhase: id,
      currentStep: 'Run the recipe',
    },
    lastEventAt: '2026-09-19T10:00:00Z',
  };
}

function ownerStep(): TaskStepProgress {
  return { index: 2, name: 'Review the diff', status: 'running', subtask: childUnit() };
}

test('a step row draws its child unit and the child rows once', () => {
  const rendered = litText(
    renderTrackerStepRow(ownerStep(), new SubtaskOpenState().scope('run-a')),
  );
  assert.match(rendered, /Review the diff/);
  assert.match(rendered, /perps-review/);
  assert.match(rendered, /Read the diff/);
});

test('the tracker row reopens a unit by default when the run changes', () => {
  // One long-lived progress-tracker element following a slot from one run to
  // the next: the element and its open-state map survive, the run id does not.
  const state = new SubtaskOpenState();
  const openFor = (runId: string) =>
    litBinding(renderTrackerStepRow(ownerStep(), state.scope(runId)), '?open=') as boolean;

  assert.equal(openFor('run-a'), true, 'an active unit opens');
  state.scope('run-a').set('perps-review', false);
  assert.equal(openFor('run-a'), false, 'the viewer collapsed it');
  assert.equal(openFor('run-b'), true, 'the slot moved to another run');
});
