import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { TaskProgressStructured, TaskStepSubtaskProgress } from '@farmslot/protocol';

import { renderPipelineProgressPanel } from './run-pipeline-panels.js';

// Flatten a lit TemplateResult (and nested results/arrays) into rendered text by
// interleaving the static `strings` with the resolved dynamic `values`.
function litText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(litText).join('');
  if (typeof value === 'object' && 'strings' in value && 'values' in value) {
    const { strings, values } = value as { strings: string[]; values: unknown[] };
    return strings.map((s, i) => s + (i < values.length ? litText(values[i]) : '')).join('');
  }
  return '';
}

function childUnit(id: string, childStepName: string): TaskStepSubtaskProgress {
  const steps = [
    { index: 1, name: childStepName, status: 'done' as const },
    { index: 2, name: `${childStepName} follow-up`, status: 'running' as const },
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
      currentStep: steps[1].name,
    },
    lastEventAt: '2026-09-19T10:00:00Z',
  };
}

function parentProgress(subtask: TaskStepSubtaskProgress): TaskProgressStructured {
  const steps = [
    { index: 1, name: 'Reproduce', status: 'done' as const },
    { index: 2, name: 'Review the diff', status: 'running' as const, subtask },
    { index: 3, name: 'Open the PR', status: 'pending' as const },
  ];
  return {
    schema: {
      flowType: 'dev',
      title: 'Dev',
      totalSteps: 3,
      phases: [{ name: 'Work', steps: steps.map(({ index, name }) => ({ index, name })) }],
    },
    phases: [{ name: 'Work', steps, completedSteps: 1, totalSteps: 3 }],
    completedSteps: 1,
    totalSteps: 3,
    currentPhase: 'Work',
    currentStep: 'Review the diff',
  };
}

test('the progress panel nests a child unit under its parent step', () => {
  const rendered = litText(
    renderPipelineProgressPanel(
      parentProgress(childUnit('perps-review', 'Read the diff')),
      'monitor',
      () => {},
      'CHECKLIST.md',
    ),
  );
  assert.match(rendered, /Review the diff/);
  assert.match(rendered, /perps-review/);
  assert.match(rendered, /Read the diff/);
});

test('child steps do not inflate the parent counts', () => {
  const rendered = litText(
    renderPipelineProgressPanel(
      parentProgress(childUnit('perps-review', 'Read the diff')),
      'monitor',
      () => {},
      'CHECKLIST.md',
    ),
  );
  // Parent header and phase row both stay at the parent's own 1/3.
  assert.match(rendered, /1\/3/);
  assert.equal(rendered.includes('1/5'), false);
});

test('rendering stops one level down', () => {
  const unit = childUnit('perps-review', 'Read the diff');
  unit.progress.phases[0].steps[0].subtask = childUnit('nested-unit', 'Nested step');
  const rendered = litText(
    renderPipelineProgressPanel(parentProgress(unit), 'monitor', () => {}, 'CHECKLIST.md'),
  );
  assert.match(rendered, /perps-review/);
  assert.equal(rendered.includes('nested-unit'), false);
  assert.equal(rendered.includes('Nested step'), false);
});
