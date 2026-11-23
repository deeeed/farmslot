import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  RunListRow,
  TaskProgressStructured,
  TaskStepSubtaskProgress,
} from '@farmslot/protocol';

import { litBinding, litText } from '../../testing/lit-text.js';

import { RunChecklistProgress } from './run-checklist-progress.js';

test('acknowledgement is visible before the checklist read and uses a 24-hour clock', () => {
  const element = new RunChecklistProgress();
  element.acknowledgedAt = '2026-11-16T01:02:03Z';
  const text = litText(element.render());
  assert.match(text, /Worker acknowledged/);
  assert.match(text, /\d{2}:\d{2}:\d{2}/);
  assert.match(text, /datetime=2026-11-16T01:02:03Z/);
  assert.doesNotMatch(text, /AM|PM|1\//);
  element.acknowledgedAt = undefined;
  assert.doesNotMatch(litText(element.render()), /Worker acknowledged/);
});

function checklist(name: string, completed: number, total: number): TaskProgressStructured {
  const steps = Array.from({ length: total }, (_, offset) => ({
    index: offset + 1,
    name: `${name} ${offset + 1}`,
    status:
      offset < completed
        ? ('done' as const)
        : offset === completed
          ? ('running' as const)
          : ('pending' as const),
  }));
  return {
    schema: { flowType: 'dev', title: name, totalSteps: total, phases: [{ name, steps }] },
    phases: [{ name, steps, completedSteps: completed, totalSteps: total }],
    completedSteps: completed,
    totalSteps: total,
    currentPhase: name,
    currentStep: steps[completed]?.name ?? null,
  };
}
function nestedElement(): RunChecklistProgress {
  const run: RunListRow = {
    id: 'run',
    familyId: 'family',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'proof',
    ticketOrPr: 'proof',
    slotId: 'slot',
    taskFile: 'TASK.md',
    branch: null,
    steps: [{ name: 'monitor', status: 'running' }],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'scripted', model: 'scripted' },
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
  };
  const element = new RunChecklistProgress();
  element.run = run;
  const parent = checklist('Parent', 0, 2);
  element.progress = parent;
  const child: TaskStepSubtaskProgress = {
    id: 'cook',
    status: 'running',
    lastEventAt: null,
    source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' },
    progress: checklist('Child', 1, 3),
  };
  parent.phases[0].steps[0].subtask = child;
  return element;
}
function parentStep(element: RunChecklistProgress) {
  const progress = element.progress;
  assert(progress && 'phases' in progress);
  return progress.phases[0].steps[0];
}
test('detail shows the active recorded child beneath the parent, with separate counts', () => {
  const element = nestedElement();
  element.showSubtasks = true;
  const text = litText(element.render());
  assert.match(text, /0\/2/);
  assert.match(text, /1\/3/);
  assert.match(text, /Child 2/);
  assert.match(text, /data-testid="?checklist-child-progress/);
  const child = parentStep(element).subtask!;
  child.progress.phases[0].steps[1].subtask = {
    ...child,
    id: 'grandchild',
    progress: checklist('Grandchild', 0, 1),
  };
  assert.doesNotMatch(litText(element.render()), /Grandchild/);
});
test('mini rows and missing child checklists stay at one level', () => {
  const element = nestedElement();
  assert.doesNotMatch(litText(element.render()), /checklist-child-progress|Child 2/);
  element.showSubtasks = true;
  parentStep(element).subtask!.progress = checklist('Empty child', 0, 0);
  assert.doesNotMatch(litText(element.render()), /checklist-child-progress|0\/0/);
});

test('saved child data is labelled and a real read failure replaces the summary', () => {
  const element = nestedElement();
  element.showSubtasks = true;
  element.stale = true;
  parentStep(element).subtask!.status = 'stale';
  const text = litText(element.render());
  assert.match(text, /Saved child progress/);
  assert.match(text, /stale/);
  element.error = 'Could not read progress';
  const failedTemplate = element.render();
  const failed = litText(failedTemplate);
  assert.deepEqual(litBinding(failedTemplate, '.notice='), {
    kind: 'error',
    text: 'Could not read progress',
  });
  assert.doesNotMatch(failed, /checklist-child-progress/);
});
