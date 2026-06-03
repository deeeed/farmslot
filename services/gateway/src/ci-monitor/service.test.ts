import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCIWatchCheckFingerprint,
  detectCIWatchProgress,
  parseCIFixProgress,
  pickCIAutoDispatchAction,
  resolveCIMonitorConfig,
  shouldReuseResolvedCIDecisionAction,
} from './service.js';

test('resolveCIMonitorConfig prefers ci_watch settings and addendum defaults', () => {
  const config = resolveCIMonitorConfig({
    ci: {
      poll_interval_min: 10,
      timeout_min: 120,
    },
    ci_watch: {
      poll_interval_s: 45,
      max_hold_min: 30,
      max_total_hold_min: 180,
      auto_dispatch: {
        merge_conflicts: false,
      },
    },
  });

  assert.equal(config.pollIntervalMs, 45_000);
  assert.equal(config.maxPollTimeMs, 30 * 60_000);
  assert.equal(config.maxTotalPollTimeMs, 180 * 60_000);
  assert.deepEqual(config.autoDispatch, {
    testFailures: true,
    mergeConflicts: false,
    botComments: true,
  });
});

test('resolveCIMonitorConfig falls back to legacy ci settings when ci_watch is absent', () => {
  const config = resolveCIMonitorConfig({
    ci: {
      poll_interval_min: 3,
      timeout_min: 90,
    },
  });

  assert.equal(config.pollIntervalMs, 180_000);
  assert.equal(config.maxPollTimeMs, 90 * 60_000);
  assert.equal(config.maxTotalPollTimeMs, 360 * 60_000);
  assert.equal(config.autoDispatch.testFailures, true);
  assert.equal('humanComments' in config.autoDispatch, false);
});

test('detectCIWatchProgress resets on PR head or watched check changes', () => {
  const first = buildCIWatchCheckFingerprint([
    { name: 'Test lint', status: 'pending' },
    { name: 'Unit tests', status: 'pending' },
  ]);
  const second = buildCIWatchCheckFingerprint([
    { name: 'Unit tests', status: 'pending' },
    { name: 'Test lint', status: 'pass' },
  ]);

  assert.equal(
    detectCIWatchProgress(
      { checkFingerprint: first, headSha: 'aaa' },
      { checkFingerprint: first, headSha: 'bbb' },
    ),
    'PR head advanced',
  );
  assert.equal(
    detectCIWatchProgress(
      { checkFingerprint: first, headSha: 'bbb' },
      { checkFingerprint: second, headSha: 'bbb' },
    ),
    'watched check status changed',
  );
  assert.equal(
    detectCIWatchProgress(
      { checkFingerprint: second, headSha: 'bbb' },
      { checkFingerprint: second, headSha: 'bbb' },
    ),
    null,
  );
});

test('pickCIAutoDispatchAction respects addendum category defaults', () => {
  const config = resolveCIMonitorConfig({});

  assert.equal(pickCIAutoDispatchAction('merge_conflict', [], config), 'dispatch-merge-main');
  assert.equal(pickCIAutoDispatchAction('bot_comments', [], config), 'dispatch-pr-complete');
  assert.equal(pickCIAutoDispatchAction('bot_comments_early', [], config), 'dispatch-pr-complete');
  assert.equal(
    pickCIAutoDispatchAction('ci_failed', ['unit-tests', 'playwright e2e'], config),
    'dispatch-pr-complete',
  );
  assert.equal(pickCIAutoDispatchAction('ci_failed', ['lint', 'typecheck'], config), null);
});

test('pickCIAutoDispatchAction honors per-project overrides', () => {
  const config = resolveCIMonitorConfig({
    ci_watch: {
      auto_dispatch: {
        test_failures: false,
        merge_conflicts: false,
        bot_comments: false,
      },
    },
  });

  assert.equal(pickCIAutoDispatchAction('merge_conflict', [], config), null);
  assert.equal(pickCIAutoDispatchAction('bot_comments', [], config), null);
  assert.equal(pickCIAutoDispatchAction('ci_failed', ['integration tests'], config), null);
});

test('shouldReuseResolvedCIDecisionAction treats transient wait controls as one-shot', () => {
  assert.equal(shouldReuseResolvedCIDecisionAction('dispatch-pr-complete'), true);
  assert.equal(shouldReuseResolvedCIDecisionAction('dispatch-merge-main'), true);
  assert.equal(shouldReuseResolvedCIDecisionAction('skip'), true);
  assert.equal(shouldReuseResolvedCIDecisionAction('abort'), true);
  assert.equal(shouldReuseResolvedCIDecisionAction('retry'), false);
  assert.equal(shouldReuseResolvedCIDecisionAction('continue'), false);
  assert.equal(shouldReuseResolvedCIDecisionAction('wait'), false);
  assert.equal(shouldReuseResolvedCIDecisionAction(null), false);
});

test('parseCIFixProgress extracts checkbox counts and current item', () => {
  assert.deepEqual(
    parseCIFixProgress(
      [
        '# CI fix',
        '- [x] Inspect failing check',
        '- [ ] Patch root cause',
        '- [ ] Run verification',
      ].join('\n'),
    ),
    {
      completed: 1,
      total: 3,
      currentLabel: 'Patch root cause',
    },
  );
});

test('parseCIFixProgress returns undefined when no checkbox progress exists', () => {
  assert.equal(parseCIFixProgress('No structured progress here'), undefined);
});
