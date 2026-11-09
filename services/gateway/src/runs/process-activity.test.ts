import assert from 'node:assert/strict';
import test from 'node:test';

import { runBundleRefs } from '@farmslot/run-bundle';

import { buildRunEpisode } from '../run-completion/run-episode.js';
import { makeRun } from '../run-engine/test-fixtures.js';

import { buildAnalyticsRecord } from './analytics.js';

test('analytics and episodes share an explicit unavailable process projection for uncaptured runs', () => {
  const run = makeRun({ status: 'done' });
  const record = buildAnalyticsRecord(run);
  assert.ok(
    record.activity,
    'Missing process capture must be recorded, not omitted or reported as zero',
  );
  const process = record.activity.process;
  assert.equal(process.markCalls, null);
  assert.equal(process.commits, null);
  assert.equal(process.rootCause.present, null);
  assert.equal(process.labels.skipped_checklist.value, null);
  assert.equal(process.labels.fix_before_baseline.value, null);
  assert.deepEqual(buildRunEpisode(run, [], [], run.updatedAt).process, process);
});

test('legacy ticks remain partial observations rather than an adherence verdict', () => {
  const run = makeRun({ status: 'done' });
  run.metrics.checklistTiming = {
    schemaVersion: 1,
    source: 'CHECKLIST.md',
    events: [
      { stepNumber: 14, label: 'CI receipt', checkedAt: '2026-11-08T01:00:00.000Z' },
      { stepNumber: 1, label: 'Start', checkedAt: '2026-11-08T02:00:00.000Z' },
    ],
  };
  const process = buildAnalyticsRecord(run).activity!.process;
  assert.deepEqual(process.checklist.events, run.metrics.checklistTiming.events);
  assert.equal(process.coverage.checklist.status, 'partial');
  assert.equal(process.labels.skipped_checklist.value, null);
  assert.deepEqual(buildRunEpisode(run, [], [], run.updatedAt).process, process);
});

test('review-fix updates cannot replace the frozen projection or drop its source bundle', () => {
  const run = makeRun({ status: 'done' });
  const activity = buildAnalyticsRecord(run).activity!;
  activity.process.attempt.contextId = 'fix-bug';
  activity.process.attempt.attemptId = 'original';
  activity.process.attempt.role = 'fix-bug';
  activity.process.attempt.executionNodeId = 'node';
  activity.process.sources = [
    {
      id: 'worker-document',
      kind: 'task-artifact',
      contextId: 'fix-bug',
      executionNodeId: 'node',
      clockId: 'node:node',
      path: 'TASK.md.worker',
      sha256: 'd'.repeat(64),
    },
  ];
  activity.process.rootCause = { present: true, source: { sourceId: 'worker-document' } };
  activity.process.coverage.rootCause = { status: 'complete', reason: 'FROZEN_WORKER_DOCUMENT' };
  const source = {
    storeId: 'store',
    bundleDigest: 'a'.repeat(64),
    taskKey: run.id,
    manifestDigest: 'b'.repeat(64),
  };
  activity.process.sourceBundle = source;
  run.metrics.activity = activity;
  run.metrics.checklistTiming = { schemaVersion: 1, source: 'REVIEW-FIX.md', events: [] };
  run.artifactBundle = { ...source, bundleDigest: 'c'.repeat(64) };
  assert.strictEqual(buildAnalyticsRecord(run).activity, activity);
  assert.strictEqual(buildRunEpisode(run, [], [], run.updatedAt).process, activity.process);
  assert.deepEqual(
    runBundleRefs(run).map((entry) => entry.ref.bundleDigest),
    ['c'.repeat(64), 'a'.repeat(64)],
  );
});
