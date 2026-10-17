import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AssessmentRecord } from '@farmslot/protocol';

import { runWithPrincipalOwner } from '../security/work-originator.js';

import { readAssessmentArtifact, saveAssessmentArtifact } from './artifacts.js';
import { assessmentEvaluate } from './evaluation.js';
import { assertAssessmentRecord } from './record-validation.js';
import { assessmentReport } from './report.js';
import {
  assessmentHistory,
  assessmentRecord,
  assessmentRecords,
  beginAssessment,
  finishAssessment,
  recordAssessmentFeedback,
  reserveAssessment,
} from './store.js';

const ownerId = 'reused-person';
const original = { ownerId };
const replacement = { ownerId, ownerGeneration: 1 };
const context = {
  ownerId,
  consumer: 'review-intake' as const,
  subject: { pr: { host: 'github.com', repo: 'example/app', number: 1, headSha: 'a'.repeat(40) } },
};
const reservation = { key: 'b'.repeat(64), maxUsd: 0.001, priceHash: 'c'.repeat(64) };
const limits = { maxCalls: 60, maxUsd: 0.1 };
const feedback = (id: string) => ({
  id,
  expectedRevision: 0,
  questionId: 'risk',
  verdict: 'correct' as const,
  adviceUsed: false,
  adviceShown: true,
  evidenceRef: 'fixture:review',
});

async function scratch(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-generation-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}
async function completed(): Promise<AssessmentRecord> {
  const record = await beginAssessment(context);
  await finishAssessment(record, {
    status: 'completed',
    provider: 'fake',
    requestedModel: 'fixed',
    answers: { risk: { type: 'boolean', probability: 0.9 } },
  });
  return record;
}
async function stored(home: string, id: string): Promise<AssessmentRecord> {
  const value: unknown = JSON.parse(
    await readFile(path.join(home, 'assessments', `${id}.json`), 'utf8'),
  );
  assertAssessmentRecord(value);
  return value;
}
const ids = (records: AssessmentRecord[]) => records.map((r) => r.id);

test('a reused id cannot see or edit generation-zero assessments, which keep working for the original', async (t) => {
  await scratch(t);
  const old = await runWithPrincipalOwner(original, async () => {
    const record = await completed();
    const reserved = await reserveAssessment(context, reservation, limits);
    assert.equal(reserved.status, 'reserved');
    return { record, reserved: reserved.status === 'reserved' ? reserved.record : undefined };
  });
  assert.equal(old.record.ownerGeneration, undefined);
  const oldReport = await runWithPrincipalOwner(original, () => assessmentReport(ownerId));
  assert.deepEqual(ids(oldReport.records).sort(), [old.record.id, old.reserved!.id].sort());

  await runWithPrincipalOwner(replacement, async () => {
    assert.deepEqual((await assessmentHistory(ownerId)).records, []);
    assert.deepEqual(await assessmentRecords(ownerId), []);
    await assert.rejects(assessmentRecord(ownerId, old.record.id), /not found/);
    await assert.rejects(recordAssessmentFeedback(ownerId, feedback(old.record.id)), /not found/);
    await assert.rejects(assessmentReport(ownerId, undefined, old.record.id), /not found/);
    await assert.rejects(assessmentReport(ownerId, oldReport.reportId), /ENOENT/);
    await assert.rejects(
      assessmentEvaluate(ownerId, { reportId: oldReport.reportId, references: [] }),
      /ENOENT/,
    );
    assert.deepEqual((await assessmentReport(ownerId)).records, []);
    // The same idempotency key reserves afresh instead of adopting the old record.
    const fresh = await reserveAssessment(context, reservation, limits);
    assert.equal(fresh.status, 'reserved');
    assert.notEqual(fresh.status === 'reserved' && fresh.record.id, old.reserved!.id);
  });

  await runWithPrincipalOwner(original, async () => {
    assert.deepEqual(
      ids((await assessmentHistory(ownerId)).records).sort(),
      [old.record.id, old.reserved!.id].sort(),
    );
    assert.equal(
      (await recordAssessmentFeedback(ownerId, feedback(old.record.id))).feedback.length,
      1,
    );
    assert.equal(
      (await assessmentReport(ownerId, oldReport.reportId)).reportId,
      oldReport.reportId,
    );
  });
});

test("the replacement's fresh record works and both generations coexist after reload", async (t) => {
  const home = await scratch(t);
  const old = await runWithPrincipalOwner(original, completed);
  const fresh = await runWithPrincipalOwner(replacement, async () => {
    const record = await completed();
    assert.equal(record.ownerGeneration, 1);
    assert.deepEqual(ids((await assessmentHistory(ownerId)).records), [record.id]);
    assert.equal((await recordAssessmentFeedback(ownerId, feedback(record.id))).feedback.length, 1);
    const report = await assessmentReport(ownerId);
    assert.deepEqual(ids(report.records), [record.id]);
    assert.equal((await assessmentReport(ownerId, report.reportId)).reportId, report.reportId);
    return record;
  });

  // Records are read from disk on every call; check the persisted form a restart loads.
  assert.equal((await stored(home, old.id)).ownerGeneration, undefined);
  assert.equal((await stored(home, fresh.id)).ownerGeneration, 1);
  await runWithPrincipalOwner(original, async () => {
    assert.deepEqual(ids(await assessmentRecords(ownerId)), [old.id]);
    await assert.rejects(assessmentRecord(ownerId, fresh.id), /not found/);
  });
  await runWithPrincipalOwner(replacement, async () => {
    assert.deepEqual(ids(await assessmentRecords(ownerId)), [fresh.id]);
    assert.equal((await assessmentRecord(ownerId, fresh.id)).feedback.length, 1);
  });
});

test('artifacts and stored reports are separated per owner generation', async (t) => {
  const home = await scratch(t);
  const id = 'd'.repeat(64);
  await runWithPrincipalOwner(original, () =>
    saveAssessmentArtifact(ownerId, 'inputs', id, { owner: 'original' }),
  );
  await runWithPrincipalOwner(replacement, async () => {
    await assert.rejects(readAssessmentArtifact(ownerId, 'inputs', id), /ENOENT/);
    await saveAssessmentArtifact(ownerId, 'inputs', id, { owner: 'replacement' });
    assert.deepEqual(await readAssessmentArtifact(ownerId, 'inputs', id), { owner: 'replacement' });
  });
  // Generation zero keeps the pre-existing directory, so old data still loads.
  const dir = (key: string) =>
    path.join(home, 'assessment-reports', createHash('sha256').update(key).digest('hex'));
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(
          home,
          'assessment-inputs',
          createHash('sha256').update(ownerId).digest('hex'),
          `${id}.json`,
        ),
        'utf8',
      ),
    ),
    { owner: 'original' },
  );

  await runWithPrincipalOwner(original, completed);
  const report = await runWithPrincipalOwner(original, () => assessmentReport(ownerId));
  const replacementDir = dir(JSON.stringify([ownerId, 1]));
  await mkdir(replacementDir, { recursive: true });
  await copyFile(
    path.join(dir(ownerId), `${report.reportId}.json`),
    path.join(replacementDir, `${report.reportId}.json`),
  );
  await runWithPrincipalOwner(replacement, () =>
    assert.rejects(assessmentReport(ownerId, report.reportId), /Invalid report owner/),
  );
});

test('stored owner generation must be a positive safe integer', () => {
  const record = {
    version: 1,
    id: '00000000-0000-4000-8000-000000000000',
    ownerId,
    consumer: 'review-intake',
    subject: {},
    startedAt: new Date().toISOString(),
    status: 'started',
    policyVersion: 'review-intake-v2',
    feedback: [],
  };
  assert.doesNotThrow(() => assertAssessmentRecord(record));
  assert.doesNotThrow(() => assertAssessmentRecord({ ...record, ownerGeneration: 2 }));
  for (const ownerGeneration of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => assertAssessmentRecord({ ...record, ownerGeneration }),
      /Invalid assessment record/,
    );
});
