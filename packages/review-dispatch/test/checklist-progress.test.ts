import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskProgressStructured } from '@farmslot/protocol';

import { ChecklistProgressReads, checklistProgressView } from '../src/checklist-progress.js';

function progress(): TaskProgressStructured {
  const steps = [
    { index: 1, name: 'Prepare', status: 'done' as const },
    { index: 2, name: 'Inspect', status: 'running' as const },
    { index: 3, name: 'Publish', status: 'pending' as const },
  ];
  return {
    schema: { flowType: 'dev', title: 'Task', totalSteps: 3, phases: [{ name: 'Setup', steps }] },
    phases: [{ name: 'Setup', steps, completedSteps: 1, totalSteps: 3 }],
    completedSteps: 1,
    totalSteps: 3,
    currentPhase: 'Setup',
    currentStep: 'Inspect',
  };
}

test('structured progress keeps recorded counts, row status and the active phase in the compact heading', () => {
  const input = progress();
  const view = checklistProgressView(input);
  assert.equal(view?.heading, 'Worker Progress 1/3 · Setup');
  assert.equal(view?.phases[0].counts, '1/3');
  assert.equal(view?.phases[0].running, true);
  assert.deepEqual(
    view?.phases[0].rows.map((row) => row.icon),
    ['v', '*', '.'],
  );
  assert.equal(view?.phases[0].rows[1].step, input.phases[0].steps[1]);
});

test('mark durations stay fixed while the current checklist row ticks, then freezes', () => {
  const input = progress();
  input.timing = {
    schemaVersion: 1,
    startedAt: '2026-10-23T01:00:00Z',
    events: [{ stepNumber: 1, label: 'Prepare', checkedAt: '2026-10-23T01:08:22Z' }],
  };
  const rowsAt = (at: string) =>
    checklistProgressView(input, { nowMs: Date.parse(at) })!.phases[0].rows;
  assert.deepEqual(
    rowsAt('2026-10-23T01:10:00Z').map((row) => row.duration),
    ['8m 22s', '1m 38s', null],
  );
  assert.deepEqual(
    rowsAt('2026-10-23T01:10:01Z').map((row) => row.duration),
    ['8m 22s', '1m 39s', null],
  );
  input.timing.finishedAt = '2026-10-23T01:11:00Z';
  assert.equal(rowsAt('2026-10-23T04:00:00Z')[1].duration, '2m 38s');
  assert.equal(rowsAt('2026-10-23T04:00:00Z')[1].live, false);
});

test('missing marks do not invent durations and legacy first marks need a known start', () => {
  const input = progress();
  assert.deepEqual(
    checklistProgressView(input)!.phases[0].rows.map((row) => row.duration),
    [null, null, null],
  );
  input.timing = {
    schemaVersion: 1,
    events: [{ stepNumber: 1, label: 'Prepare', checkedAt: '2026-10-23T01:08:22Z' }],
  };
  const rows = checklistProgressView(input, { nowMs: Date.parse('2026-10-23T01:10:00Z') })!
    .phases[0].rows;
  assert.equal(rows[0].duration, null);
  assert.equal(rows[1].duration, '1m 38s');
});

test('review-fix and CI work use the existing checklist role labels', () => {
  assert.match(
    checklistProgressView(progress(), {
      activeStep: 'human-gate',
      activeTaskBasename: 'REVIEW-FIX.md',
    })?.heading ?? '',
    /^Review Fix Progress/,
  );
  assert.match(
    checklistProgressView(progress(), { activeStep: 'ci-watch' })?.heading ?? '',
    /^CI Fix Progress/,
  );
});

test('legacy markdown uses canonical checkbox enumeration instead of counting acceptance criteria', () => {
  const view = checklistProgressView(undefined, {
    markdown:
      '# Work\n- [x] Prepare\n- [ ] Inspect\n\n## Acceptance Criteria\n- [ ] AC-1 is a declaration\n',
  });
  assert.equal(view?.counts, '1/2');
  assert.equal(view?.phases[0].rows[1].step.status, 'pending');
});

test('flat slot rows share the same counts and do not claim that a pending row is running', () => {
  const view = checklistProgressView(undefined, {
    steps: [
      { text: 'Prepare', checked: true },
      { text: 'Inspect', checked: false },
    ],
  });
  assert.equal(view?.heading, 'Worker Progress 1/2');
  assert.equal(view?.percent, 50);
  assert.equal(view?.phases[0].running, false);
});

test('missing structured progress retains the fallback context without inventing a percentage', () => {
  assert.equal(checklistProgressView(undefined), null);
  const view = checklistProgressView(undefined, {
    fallback: { title: 'Worker Progress', meta: 'Waiting for checklist', percent: null },
  });
  assert.equal(view?.waiting, true);
  assert.equal(view?.percent, null);
  assert.equal(view?.counts, null);
  assert.equal(view?.heading, 'Worker Progress');
});

test('reconnect hydration replaces cached counts, while a live event wins over an in-flight read', async () => {
  const reads = new ChecklistProgressReads();
  reads.select('same-attempt');
  let completed = 2;
  const reconnect = reads.begin('same-attempt');
  await Promise.resolve().then(() => {
    if (reads.isCurrent(reconnect)) completed = 4;
  });
  assert.equal(completed, 4);
  const pending = reads.begin('same-attempt');
  reads.invalidate();
  completed = 5;
  await Promise.resolve().then(() => {
    if (reads.isCurrent(pending)) completed = 3;
  });
  assert.equal(completed, 5);
});

test('an old attempt resolving after its replacement cannot hide the new progress snapshot', async () => {
  const reads = new ChecklistProgressReads();
  let snapshot = { key: 'A', completed: 2 };
  reads.select('A');
  const older = reads.begin('A');
  let finishOlder = () => {};
  const oldResponse = new Promise<void>((resolve) => {
    finishOlder = resolve;
  }).then(() => {
    if (reads.isCurrent(older)) snapshot = { key: 'A', completed: 3 };
  });
  reads.select('B');
  const newer = reads.begin('B');
  await Promise.resolve().then(() => {
    if (reads.isCurrent(newer)) snapshot = { key: 'B', completed: 4 };
  });
  finishOlder();
  await oldResponse;
  assert.deepEqual(snapshot, { key: 'B', completed: 4 });
});
