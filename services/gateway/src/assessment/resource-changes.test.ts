import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { resourceRevisions } from '../resources/revisions.js';

import { readAssessmentArtifact, saveAssessmentArtifact } from './artifacts.js';
import {
  assessmentHistory,
  assessmentRecord,
  beginAssessment,
  finishAssessment,
  recordAssessmentFeedback,
  recordAuditFailure,
  reserveAssessment,
} from './store.js';

const key: ResourceKey = { family: 'assessment', scope: 'farm' };
const context = { ownerId: 'assessment-reader', consumer: 'smoke-test' as const, subject: {} };

for (const kind of ['history', 'detail'] as const) {
  test(`an observed ${kind} expires without another writer or periodic read`, async (t) => {
    const home = await scratch(t);
    resourceRevisions.dispose();
    t.after(() => resourceRevisions.dispose());
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const record = await beginAssessment(context);
    await finishAssessment(record, { status: 'completed' });
    const file = path.join(home, 'assessments', `${record.id}.json`);
    const saved = await readFile(file);
    if (kind === 'history') await assessmentHistory(context.ownerId);
    else await assessmentRecord(context.ownerId, record.id);
    const before = resourceRevisions.revision(key);
    t.mock.timers.tick(30 * 86400_000);
    assert.equal(resourceRevisions.revision(key), before);
    t.mock.timers.tick(1);
    assert.equal(resourceRevisions.revision(key), before + 1);
    assert.equal((await assessmentHistory(context.ownerId)).records.length, 0);
    await assert.rejects(assessmentRecord(context.ownerId, record.id), /expired/);
    assert.equal(
      resourceRevisions.revision(key),
      before + 1,
      'The fired expiry is not published twice',
    );
    assert.deepEqual(
      await readFile(file),
      saved,
      'Expiry invalidation must not rewrite the source',
    );
  });
}

test('a read catches an overdue expiry before replacing its delayed timer', async (t) => {
  await scratch(t);
  resourceRevisions.dispose();
  t.after(() => resourceRevisions.dispose());
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const record = await beginAssessment(context);
  await finishAssessment(record, { status: 'completed' });
  await assessmentHistory(context.ownerId);
  const before = resourceRevisions.revision(key);
  // Wall time passed while the timer callback is still waiting for an event-loop turn.
  t.mock.method(Date, 'now', () => now + 30 * 86400_000 + 1);
  assert.equal((await assessmentHistory(context.ownerId)).records.length, 0);
  assert.equal(resourceRevisions.revision(key), before + 1);
  await assessmentHistory(context.ownerId);
  assert.equal(resourceRevisions.revision(key), before + 1, 'The same expiry publishes once');
});

async function scratch(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-resource-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('assessment commits publish only the farm key after records are readable', async (t) => {
  const home = await scratch(t);
  const before = resourceRevisions.revision(key);
  const record = await beginAssessment(context);
  assert.equal(resourceRevisions.revision(key), before + 1);
  const file = path.join(home, 'assessments', `${record.id}.json`);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'started');
  await finishAssessment(record, {
    status: 'completed',
    answers: { color: { type: 'choice', choice: 'blue', choices: ['blue', 'red'] } },
  });
  assert.equal(resourceRevisions.revision(key), before + 2);
  assert.equal((await assessmentHistory(context.ownerId)).records[0]?.status, 'completed');
  const params = {
    id: record.id,
    expectedRevision: 0,
    questionId: 'color',
    verdict: 'correct' as const,
    adviceUsed: false,
    adviceShown: true,
    evidenceRef: 'fixture:source',
  };
  await assert.rejects(recordAssessmentFeedback('foreign-owner', params), /not found/);
  assert.equal(resourceRevisions.revision(key), before + 2, 'Refused writes do not invalidate');
  await recordAssessmentFeedback(context.ownerId, params);
  assert.equal(resourceRevisions.revision(key), before + 3);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).feedback.length, 1);
  assert.deepEqual(resourceRevisions.notice([key]).changes[0]?.key, key);
});

test('reservation reuse does not publish, pruning and visible audit failures do', async (t) => {
  await scratch(t);
  const reservation = { key: 'b'.repeat(64), maxUsd: 0.001, priceHash: 'c'.repeat(64) };
  const limits = { maxCalls: 10, maxUsd: 0.1 };
  const before = resourceRevisions.revision(key);
  const first = await reserveAssessment(context, reservation, limits);
  assert.equal(first.status, 'reserved');
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.equal((await reserveAssessment(context, reservation, limits)).status, 'existing');
  assert.equal(resourceRevisions.revision(key), before + 1);
  if (first.status !== 'reserved') throw new Error('Expected a fresh reservation');
  await finishAssessment(first.record, { status: 'disabled' });
  const beforePrune = resourceRevisions.revision(key);
  const future = Date.now() + 31 * 86_400_000;
  t.mock.method(Date, 'now', () => future);
  await beginAssessment(context);
  assert.equal(
    resourceRevisions.revision(key),
    beforePrune + 2,
    'One removal and one readable create',
  );
  recordAuditFailure();
  assert.equal(resourceRevisions.revision(key), beforePrune + 3);
  assert.equal((await assessmentHistory(context.ownerId)).auditHealth.status, 'degraded');
});

test('failed creation does not publish; saved artifacts invalidate report and evidence reads', async (t) => {
  const home = await scratch(t);
  await writeFile(path.join(home, 'assessments'), 'not a directory');
  const before = resourceRevisions.revision(key);
  await assert.rejects(beginAssessment(context));
  assert.equal(resourceRevisions.revision(key), before);
  const id = 'd'.repeat(64);
  await saveAssessmentArtifact(context.ownerId, 'reports', id, { result: 'readable' });
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.deepEqual(await readAssessmentArtifact(context.ownerId, 'reports', id), {
    result: 'readable',
  });
  assert.equal((await readdir(path.join(home, 'assessment-reports'))).length, 1);
  assert((await stat(path.join(home, 'assessment-reports'))).isDirectory());
});

test('a refused completion preserves its error and publishes interrupted visibility', async (t) => {
  await scratch(t);
  const record = await beginAssessment(context);
  const before = resourceRevisions.revision(key);
  await assert.rejects(
    finishAssessment(record, { status: 'completed', returnedModel: 'bad\u0000identity' }),
    /Invalid/,
  );
  assert.equal(resourceRevisions.revision(key), before + 1);
  assert.equal((await assessmentHistory(context.ownerId)).records[0]?.status, 'interrupted');
});
