import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { TaskProgressStructured, TaskStepSubtaskProgress } from '@farmslot/protocol';

import { litBinding, litText } from '../../testing/lit-text.js';

import {
  renderSubtaskBlock,
  type SubtaskOpenScope,
  SubtaskOpenState,
  subtaskPresentation,
} from './subtask-block.js';

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

function unitFixture(overrides: Partial<TaskStepSubtaskProgress> = {}): TaskStepSubtaskProgress {
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
  const view = subtaskPresentation(unitFixture());
  assert.equal(view.title, 'skill.md');
  assert.equal(view.titleTooltip, 'skill · .agents/skills/mms-perps-review-pr/skill.md');
  assert.equal(view.counts, '2/5');
  assert.equal(view.currentStep, 'Child step 3');
  assert.equal(view.settled, false);
});

test('an inline unit has no ref to show', () => {
  const view = subtaskPresentation(
    unitFixture({ source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' } }),
  );
  assert.equal(view.title, 'inline');
  assert.equal(view.titleTooltip, 'inline text');
});

test('a stale unit explains itself with the last child mark', () => {
  const view = subtaskPresentation(unitFixture({ status: 'stale' }));
  assert.equal(view.statusLabel, 'stale');
  assert.match(view.statusTooltip, /No child mark since 2026-09-19T10:58:00Z/);
  assert.equal(view.settled, false);
});

test('blocked keeps step ownership, complete settles it', () => {
  assert.equal(subtaskPresentation(unitFixture({ status: 'blocked' })).settled, false);
  assert.equal(subtaskPresentation(unitFixture({ status: 'complete' })).settled, true);
  assert.equal(subtaskPresentation(unitFixture({ status: 'done' })).settled, true);
});

test('the block renders the child steps through the host row renderer', () => {
  const rendered = litText(
    renderSubtaskBlock(
      unitFixture(),
      (step) => `[row:${step.name}:${step.status}]`,
      new SubtaskOpenState().scope('run-a'),
    ),
  );
  assert.match(rendered, /perps-review/);
  assert.match(rendered, /running/);
  assert.match(rendered, /\[row:Child step 1:done\]/);
  assert.match(rendered, /\[row:Child step 5:pending\]/);
});

/** The `?open` value the block binds on `<details>` for this render. */
function openBinding(unit: TaskStepSubtaskProgress, scope: SubtaskOpenScope): boolean {
  return litBinding(
    renderSubtaskBlock(unit, (step) => step.name, scope),
    '?open=',
  ) as boolean;
}

/** The `@toggle` listener the block wires, so a test can fire the real event. */
function toggleListener(
  unit: TaskStepSubtaskProgress,
  scope: SubtaskOpenScope,
): (event: Event) => void {
  return litBinding(
    renderSubtaskBlock(unit, (step) => step.name, scope),
    '@toggle=',
  ) as (event: Event) => void;
}

/** A `toggle` event as `<details>` fires it, carrying the new open state. */
function fireToggle(listener: (event: Event) => void, open: boolean): void {
  listener({ target: { open } } as unknown as Event);
}

test('the block binds the open state it is given, not the status default', () => {
  const state = new SubtaskOpenState().scope('run-a');
  const unit = unitFixture({ status: 'running' });
  state.set(unit.id, false);
  assert.equal(
    openBinding(unit, state),
    false,
    'a running unit the viewer closed must render closed',
  );

  const settled = unitFixture({ id: 'settled-unit', status: 'complete' });
  state.set(settled.id, true);
  assert.equal(
    openBinding(settled, state),
    true,
    'a settled unit the viewer opened must render open',
  );
});

test('an active unit opens by default and stays closed once the viewer closes it', () => {
  const state = new SubtaskOpenState().scope('run-a');
  assert.equal(
    openBinding(unitFixture({ status: 'running' }), state),
    true,
    'an active unit opens on first sight',
  );

  fireToggle(toggleListener(unitFixture({ status: 'running' }), state), false);

  // A live progress update hands the block a brand new projection object; the
  // viewer's collapse must survive it.
  const updated = unitFixture({ status: 'running', progress: childProgress(3, 5) });
  assert.equal(openBinding(updated, state), false, 'the viewer kept it closed');
});

test('a settled unit starts closed and stays open once the viewer opens it', () => {
  const state = new SubtaskOpenState().scope('run-a');
  assert.equal(
    openBinding(unitFixture({ status: 'complete' }), state),
    false,
    'a settled unit starts collapsed',
  );

  fireToggle(toggleListener(unitFixture({ status: 'complete' }), state), true);

  assert.equal(
    openBinding(unitFixture({ status: 'complete' }), state),
    true,
    'the viewer kept it open across a re-render',
  );
});

test("a unit that settles while open keeps the viewer's state, not the new default", () => {
  const state = new SubtaskOpenState().scope('run-a');
  openBinding(unitFixture({ status: 'running' }), state);
  fireToggle(toggleListener(unitFixture({ status: 'running' }), state), false);

  // running → complete would default to closed anyway; the point is the default
  // is never re-applied, so the map is the only source of truth after first sight.
  assert.equal(openBinding(unitFixture({ status: 'complete' }), state), false);

  fireToggle(toggleListener(unitFixture({ status: 'complete' }), state), true);
  assert.equal(openBinding(unitFixture({ status: 'complete' }), state), true);
});

test('each unit id remembers its own state', () => {
  const state = new SubtaskOpenState().scope('run-a');
  const first = unitFixture({ id: 'perps-review', status: 'running' });
  const second = unitFixture({ id: 'ci-triage', status: 'running' });
  openBinding(first, state);
  openBinding(second, state);
  fireToggle(toggleListener(first, state), false);
  assert.equal(openBinding(first, state), false);
  assert.equal(openBinding(second, state), true, 'the other unit is untouched');
});

test('the same unit id under a different run starts from the default again', () => {
  const state = new SubtaskOpenState();
  const runA = state.scope('run-a');
  const runB = state.scope('run-b');
  const unit = () => unitFixture({ id: 'perps-review', status: 'running' });

  openBinding(unit(), runA);
  fireToggle(toggleListener(unit(), runA), false);
  assert.equal(openBinding(unit(), runA), false, 'run A keeps what the viewer chose');

  assert.equal(
    openBinding(unit(), runB),
    true,
    'a different run must not inherit run A collapse for the same unit id',
  );
  assert.equal(openBinding(unit(), runA), false, "run B's default left run A untouched");
});

test('a settled unit opened in one run does not open in the next', () => {
  const state = new SubtaskOpenState();
  const settled = () => unitFixture({ id: 'ci-parity', status: 'complete' });
  fireToggle(toggleListener(settled(), state.scope('run-a')), true);
  assert.equal(openBinding(settled(), state.scope('run-a')), true);
  assert.equal(openBinding(settled(), state.scope('run-b')), false, 'run B falls back to settled');
});

test('a host with no run identity still keeps one scope', () => {
  const state = new SubtaskOpenState();
  const unit = () => unitFixture({ status: 'running' });
  fireToggle(toggleListener(unit(), state.scope(undefined)), false);
  assert.equal(openBinding(unit(), state.scope(undefined)), false);
  assert.equal(openBinding(unit(), state.scope('')), false, 'blank and absent are the same scope');
});

test('only the three most recent runs are remembered', () => {
  const state = new SubtaskOpenState();
  const unit = () => unitFixture({ id: 'perps-review', status: 'running' });
  for (const run of ['run-1', 'run-2', 'run-3']) {
    openBinding(unit(), state.scope(run));
    state.scope(run).set('perps-review', false);
  }
  assert.equal(openBinding(unit(), state.scope('run-1')), false, 'still remembered');

  // run-4 is the fourth distinct run; the least recently scoped one falls off.
  // Scoping run-1 above made run-2 the oldest.
  openBinding(unit(), state.scope('run-4'));
  assert.equal(openBinding(unit(), state.scope('run-2')), true, 'the oldest run was forgotten');
  assert.equal(openBinding(unit(), state.scope('run-1')), false, 'a recent run is untouched');
});

test('re-scoping a run keeps it from being pruned', () => {
  const state = new SubtaskOpenState();
  const unit = () => unitFixture({ id: 'ci-parity', status: 'running' });
  state.scope('run-a').set('ci-parity', false);
  for (const run of ['run-b', 'run-c']) openBinding(unit(), state.scope(run));
  state.scope('run-a'); // the viewer came back before the fourth run
  openBinding(unit(), state.scope('run-d'));
  assert.equal(openBinding(unit(), state.scope('run-a')), false, 'run A survived as recent');
  assert.equal(openBinding(unit(), state.scope('run-b')), true, 'run B aged out instead');
});
