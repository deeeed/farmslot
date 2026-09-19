import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { TaskProgressStructured, TaskStepSubtaskProgress } from '@farmslot/protocol';

import { renderSubtaskBlock, subtaskPresentation } from './subtask-block.js';

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

function childProgress(completed: number, total: number): TaskProgressStructured {
  const steps = Array.from({ length: total }, (_, index) => ({
    index: index + 1,
    name: `Child step ${index + 1}`,
    status:
      index + 1 <= completed
        ? ('done' as const)
        : index + 1 === completed + 1
          ? ('running' as const)
          : ('pending' as const),
  }));
  return {
    schema: {
      flowType: 'subtask',
      title: 'Child unit',
      totalSteps: total,
      phases: [{ name: 'Child unit', steps: steps.map(({ index, name }) => ({ index, name })) }],
    },
    phases: [{ name: 'Child unit', steps, completedSteps: completed, totalSteps: total }],
    completedSteps: completed,
    totalSteps: total,
    currentPhase: 'Child unit',
    currentStep: steps.find((step) => step.status === 'running')?.name ?? null,
  };
}

function unit(overrides: Partial<TaskStepSubtaskProgress> = {}): TaskStepSubtaskProgress {
  return {
    id: 'perps-review',
    status: 'running',
    source: {
      kind: 'skill',
      ref: '.agents/skills/mms-perps-review-pr/skill.md',
      sha256: 'aaa',
      renderedSha256: 'bbb',
    },
    progress: childProgress(2, 5),
    lastEventAt: '2026-09-19T10:58:00Z',
    ...overrides,
  };
}

test('presentation titles a unit by its source ref basename', () => {
  const view = subtaskPresentation(unit());
  assert.equal(view.title, 'skill.md');
  assert.equal(view.titleTooltip, 'skill · .agents/skills/mms-perps-review-pr/skill.md');
  assert.equal(view.counts, '2/5');
  assert.equal(view.currentStep, 'Child step 3');
  assert.equal(view.settled, false);
});

test('an inline unit has no ref to show', () => {
  const view = subtaskPresentation(
    unit({ source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' } }),
  );
  assert.equal(view.title, 'inline');
  assert.equal(view.titleTooltip, 'inline text');
});

test('a stale unit explains itself with the last child mark', () => {
  const view = subtaskPresentation(unit({ status: 'stale' }));
  assert.equal(view.statusLabel, 'stale');
  assert.match(view.statusTooltip, /No child mark since 2026-09-19T10:58:00Z/);
  assert.equal(view.settled, false);
});

test('blocked keeps step ownership, complete settles it', () => {
  assert.equal(subtaskPresentation(unit({ status: 'blocked' })).settled, false);
  assert.equal(subtaskPresentation(unit({ status: 'complete' })).settled, true);
  assert.equal(subtaskPresentation(unit({ status: 'done' })).settled, true);
});

test('the block renders the child steps through the host row renderer', () => {
  const rendered = litText(
    renderSubtaskBlock(unit(), (step) => `[row:${step.name}:${step.status}]`),
  );
  assert.match(rendered, /perps-review/);
  assert.match(rendered, /running/);
  assert.match(rendered, /\[row:Child step 1:done\]/);
  assert.match(rendered, /\[row:Child step 5:pending\]/);
});
