import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eligibleRunIds,
  EMPTY_MACHINE_PAUSE_SELECTOR,
  machineParkRecordSummary,
  machineParkResidualAssessment,
  machinePauseMutationDisabled,
  machinePauseShouldRefetch,
  machinePressurePercent,
  restoreExecuteParams,
  reviewedPauseTargets,
  reviewedRestoreTargets,
  selectedRejectedRunCount,
  selectorForAllEligible,
  selectorForRunToggle,
  sortMachinePauseRecords,
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

test('restore execution preserves default-all and exclude selectors exactly', () => {
  const all = restoreExecuteParams('macwork', {
    previewId: 'restore-all',
    selector: { kind: 'all' },
    runs,
  });
  assert.deepEqual(all.selector, { kind: 'all' });
  assert.deepEqual(all.reviewedTargets, [{ runId: 'run-a', generation: 4 }]);

  const exclude = restoreExecuteParams('macwork', {
    previewId: 'restore-exclude',
    selector: { kind: 'exclude', runIds: ['run-c'] },
    runs,
  });
  assert.deepEqual(exclude.selector, { kind: 'exclude', runIds: ['run-c'] });
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
  assert.equal(
    machinePauseMutationDisabled({
      reviewedTargetCount: 2,
      selectedRejectedCount: 0,
      confirmed: true,
      busy: false,
      connectionStale: true,
    }),
    true,
  );
});

test('durable record summary surfaces errors and residual state', () => {
  const record = {
    mode: 'release',
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
  assert.equal(machineParkRecordSummary(record), 'partial · 1 action error(s)');
  assert.equal(machinePressurePercent(0.824), '82%');
  assert.equal(machinePressurePercent(undefined), '–');
});

test('residual assessment treats mode-and-phase expected running states as healthy', () => {
  const orchestrationPaused = machineParkResidualAssessment({
    mode: 'orchestration',
    phase: 'orchestration-paused',
    residuals: {
      runner: 'running',
      resources: [{ resourceId: 'metro', state: 'running' }],
    },
  });
  assert.equal(orchestrationPaused.hasWarnings, false);
  assert.equal(orchestrationPaused.runner.expected, 'running');

  const releaseRestored = machineParkResidualAssessment({
    mode: 'release',
    phase: 'restored',
    residuals: {
      runner: 'running',
      resources: [{ resourceId: 'simulator', state: 'running' }],
    },
  });
  assert.equal(releaseRestored.hasWarnings, false);
  assert.equal(releaseRestored.resources[0].expected, 'running');

  const unexpected = machineParkResidualAssessment({
    mode: 'release',
    phase: 'parked',
    residuals: {
      runner: 'running',
      resources: [
        { resourceId: 'metro', state: 'unknown' },
        { resourceId: 'simulator', state: 'stopped' },
      ],
    },
  });
  assert.equal(unexpected.hasWarnings, true);
  assert.equal(unexpected.runner.warning, true);
  assert.equal(unexpected.resources[0].warning, true);
  assert.equal(unexpected.resources[1].warning, false);
});

test('updated pause records sort newest first with deterministic ties', () => {
  assert.deepEqual(
    sortMachinePauseRecords([
      { runId: 'run-b', updatedAt: '2026-08-21T01:00:00.000Z' },
      { runId: 'run-c', updatedAt: '2026-08-21T02:00:00.000Z' },
      { runId: 'run-a', updatedAt: '2026-08-21T01:00:00.000Z' },
    ]).map((record) => record.runId),
    ['run-c', 'run-a', 'run-b'],
  );
});

test('progress merges suppress refetch during mutation while completion refetches once', () => {
  assert.equal(machinePauseShouldRefetch('progress', 'execute'), false);
  assert.equal(machinePauseShouldRefetch('progress', 'restore'), false);
  assert.equal(machinePauseShouldRefetch('progress', null), true);
  assert.equal(machinePauseShouldRefetch('completion', 'execute'), true);
  assert.equal(machinePauseShouldRefetch('completion', 'restore'), true);
});
