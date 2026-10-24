import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ANALYTICS_RECORD_SCHEMA_VERSION, type RunAnalyticsRecord } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

const root = mkdtempSync(path.join(os.tmpdir(), 'analytics-resource-writes-'));
const sink = path.join(root, 'sink');
process.env.NODE_ENV = 'test';
process.env.FARMSLOT_ANALYTICS_DIR = sink;
const { appendAnalyticsRecord, readAllAnalyticsRecords, aggregateAnalytics } =
  await import('./analytics.js');
const { resourceRevisions } = await import('../resources/revisions.js');
test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(project: string, runId: string): RunAnalyticsRecord {
  return {
    schemaVersion: ANALYTICS_RECORD_SCHEMA_VERSION,
    ts: '2026-10-24T00:00:00.000Z',
    runId,
    project,
    host: 'private-host',
    slotId: null,
    flowType: 'fix-bug',
    lane: 'production',
    runner: null,
    model: null,
    status: 'done',
    outcome: 'success',
    failedStep: null,
    failureReason: null,
    steps: [],
    wallMs: null,
    idleMs: null,
    nudgeCount: 0,
    reviewLoops: null,
    ciResult: null,
    ciPollCount: null,
    ciInlineFixAttempts: null,
    humanReviewersRequestingChanges: null,
    hostLoad: null,
    templateKey: null,
  };
}

const farm = { family: 'analytics', scope: 'farm' } as const;
const alpha = { ...farm, project: 'alpha' };
const beta = { ...farm, project: 'beta' };

test('committed appends publish both corpus and project keys, including cross-project dimensions', async () => {
  const beforeFarm = resourceRevisions.revision(farm);
  const beforeAlpha = resourceRevisions.revision(alpha);
  const beforeBeta = resourceRevisions.revision(beta);
  await appendAnalyticsRecord(record('alpha', 'alpha-run'));
  assert(resourceRevisions.revision(farm) > beforeFarm);
  assert(resourceRevisions.revision(alpha) > beforeAlpha);
  assert.equal(resourceRevisions.revision(beta), beforeBeta);
  const committed: unknown = JSON.parse(
    (await readFile(path.join(sink, 'events-2026-10.ndjson'), 'utf8')).trim(),
  );
  assert(committed && typeof committed === 'object');
  assert.equal(
    Reflect.get(committed, 'runId'),
    'alpha-run',
    'Published data must already be readable',
  );

  const query = resourceQuery('analytics.query', { project: 'alpha' });
  assert(
    query.dependencies.some((key) => key.family === 'analytics' && !key.project),
    'A project query still displays corpus-wide dimensions and count',
  );
  const beforeOtherProject = resourceRevisions.revision(farm);
  await appendAnalyticsRecord(record('beta', 'beta-run'));
  assert(resourceRevisions.revision(farm) > beforeOtherProject);
  const read = await readAllAnalyticsRecords();
  const projection = aggregateAnalytics(
    read.records,
    { project: 'alpha' },
    '2026-10-24T01:00:00.000Z',
  );
  assert.equal(projection.matchedRuns, 1);
  assert.equal(projection.scannedRuns, 2);
  assert.deepEqual(projection.dimensions.projects, ['alpha', 'beta']);
});

test('failed sink writes never publish a successful analytics revision', async () => {
  await rm(sink, { recursive: true });
  await writeFile(sink, 'a file cannot be the analytics directory');
  const beforeFarm = resourceRevisions.revision(farm);
  const beforeAlpha = resourceRevisions.revision(alpha);
  await assert.rejects(appendAnalyticsRecord(record('alpha', 'refused-run')));
  assert.equal(resourceRevisions.revision(farm), beforeFarm);
  assert.equal(resourceRevisions.revision(alpha), beforeAlpha);
});
