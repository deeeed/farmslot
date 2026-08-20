import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eligibleRunIds,
  EMPTY_MACHINE_PAUSE_SELECTOR,
  machineParkRecordSummary,
  machinePauseMutationDisabled,
  machinePressurePercent,
  reviewedPauseTargets,
  reviewedRestoreTargets,
  selectedRejectedRunCount,
  selectorForAllEligible,
  selectorForRunToggle,
} from './machine-pause-dialog-model.js';

const runs = [
  { runId: 'run-a', generation: 4, selected: true, eligibility: { eligible: true } },
  { runId: 'run-b', generation: 8, selected: true, eligibility: { eligible: false } },
  { runId: 'run-c', generation: 2, selected: false, eligibility: { eligible: true } },
];

test('backend selection and eligibility jointly determine exact reviewed targets', () => {
  assert.deepEqual([...eligibleRunIds(runs)], ['run-a', 'run-c']);
  assert.deepEqual(reviewedPauseTargets({ runs }), [{ runId: 'run-a', generation: 4 }]);
  assert.equal(selectedRejectedRunCount(runs), 1);
});

test('pause and restore use the exact backend generations reviewed by the operator', () => {
  assert.deepEqual(reviewedPauseTargets({ runs }), [{ runId: 'run-a', generation: 4 }]);
  assert.deepEqual(reviewedRestoreTargets({ runs }), [{ runId: 'run-a', generation: 4 }]);
});

test('selection controls request explicit backend selectors', () => {
  assert.deepEqual(selectorForRunToggle(runs, 'run-c', true), {
    kind: 'include',
    runIds: ['run-a', 'run-c'],
  });
  assert.deepEqual(selectorForRunToggle(runs, 'run-a', false), {
    kind: 'include',
    runIds: [],
  });
  assert.deepEqual(selectorForAllEligible(runs), {
    kind: 'include',
    runIds: ['run-a', 'run-c'],
  });
  assert.deepEqual(EMPTY_MACHINE_PAUSE_SELECTOR, { kind: 'include', runIds: [] });
});

test('a backend-confirmed Clear leaves no reviewed targets and keeps mutation disabled', () => {
  const clearedRuns = runs.map((run) => ({ ...run, selected: false }));
  assert.deepEqual(reviewedPauseTargets({ runs: clearedRuns }), []);
  assert.deepEqual(reviewedRestoreTargets({ runs: clearedRuns }), []);
  assert.equal(
    machinePauseMutationDisabled({
      reviewedTargetCount: 0,
      selectedRejectedCount: 0,
      confirmed: true,
      busy: false,
      connectionStale: false,
    }),
    true,
  );
  assert.equal(
    machinePauseMutationDisabled({
      reviewedTargetCount: 2,
      selectedRejectedCount: 0,
      confirmed: true,
      busy: false,
      connectionStale: false,
    }),
    false,
  );
});

test('durable record summary surfaces errors and residual state', () => {
  const record = {
    phase: 'partial',
    errors: [{ code: 'resource-stop-failed' }],
    residuals: {
      runner: 'running',
      resources: [
        { resourceId: 'metro', state: 'running' },
        { resourceId: 'simulator', state: 'stopped' },
      ],
    },
  } as const;
  assert.equal(
    machineParkRecordSummary(record),
    'partial · 1 action error(s) · runner running · 1 residual resource(s)',
  );
  assert.equal(machinePressurePercent(0.824), '82%');
  assert.equal(machinePressurePercent(undefined), '–');
});
