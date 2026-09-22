import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { monitorAssessment } from './monitor.js';
import {
  assessmentHistory,
  beginAssessment,
  finishAssessment,
  recordAssessmentFeedback,
} from './store.js';
import { summarizeAssessments } from './summary.js';

const subject = {
  pr: { host: 'github.com', repo: 'example/app', number: 1, headSha: 'a'.repeat(40) },
};
const context = { ownerId: 'alice', consumer: 'review-intake' as const, subject };

test('durable assessment history, owner isolation, feedback revisions and interruption', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-store-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const attempt = await beginAssessment(context);
  await finishAssessment(attempt, {
    status: 'completed',
    provider: 'fake',
    requestedModel: 'fixed',
    answers: { risk: { type: 'boolean', probability: 0.9 } },
    usage: {
      provider: 'fake',
      requestedModel: 'fixed',
      durationMs: 5,
      inputTokens: 10,
      outputTokens: 2,
    },
  });
  assert.equal((await assessmentHistory('bob')).records.length, 0);
  const rows = (await assessmentHistory('alice')).records;
  assert.equal(rows[0].id, attempt.id);
  assert.equal(
    (await stat(path.join(home, 'assessments', `${attempt.id}.json`))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    recordAssessmentFeedback('bob', {
      id: attempt.id,
      expectedRevision: 0,
      questionId: 'risk',
      verdict: 'correct',
      adviceUsed: false,
      adviceShown: true,
      evidenceRef: 'fixture:review',
      correctedAnswer: false,
    }),
    /not found/,
  );
  const updated = await recordAssessmentFeedback('alice', {
    id: attempt.id,
    expectedRevision: 0,
    questionId: 'risk',
    verdict: 'incorrect',
    adviceUsed: false,
    adviceShown: true,
    evidenceRef: 'fixture:review',
    correctedAnswer: false,
  });
  assert.equal(updated.feedback.length, 1);
  await assert.rejects(
    recordAssessmentFeedback('alice', {
      id: attempt.id,
      expectedRevision: 0,
      questionId: 'risk',
      verdict: 'correct',
      adviceUsed: false,
      adviceShown: true,
      evidenceRef: 'fixture:review',
      correctedAnswer: false,
    }),
    /reload/,
  );
  const saved = JSON.parse(
    await readFile(path.join(home, 'assessments', `${attempt.id}.json`), 'utf8'),
  );
  assert.equal(saved.feedback[0].verdict, 'incorrect');
  saved.status = 'started';
  await writeFile(path.join(home, 'assessments', `${attempt.id}.json`), JSON.stringify(saved));
  assert.equal((await assessmentHistory('alice')).records[0].status, 'interrupted');
  assert.equal((await readdir(path.join(home, 'assessments'))).length, 1);
});

test('audit failure prevents provider execution and remains a visible skipped result', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-audit-fail-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(home, 'assessments'), 'cannot be a directory');
  let calls = 0;
  const result = await monitorAssessment(context, async () => {
    calls++;
    return { status: 'completed' };
  });
  assert.equal(calls, 0);
  assert.ok('monitoringError' in result);
});

test('summary excludes synthetic calls, counts unknowns honestly and deduplicates cases', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-summary-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const record = await beginAssessment(context);
    await finishAssessment(record, {
      status: 'completed',
      provider: 'fake',
      requestedModel: 'fixed',
      questionSchemaHash: 'b'.repeat(64),
      answers: { risk: { type: 'boolean', probability: 0.8 } },
      usage: {
        provider: 'fake',
        requestedModel: 'fixed',
        durationMs: 10,
        inputTokens: 5,
        outputTokens: 1,
      },
    });
  }
  const smoke = await beginAssessment({ ...context, consumer: 'smoke-test' });
  await finishAssessment(smoke, { status: 'completed' });
  const report = summarizeAssessments((await assessmentHistory('alice')).records);
  assert.equal(report.calls, 2);
  assert.equal(report.uniqueCases, 1);
  assert.equal(report.tokens, 12);
  assert.equal(report.accuracy, null);
  assert.equal(report.savings, null);
});

test('invalid provider metadata is rejected from both storage and returned result', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'assessment-private-'));
  const old = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  process.env.ASSESSMENT_TEST_API_KEY = 'credential-sentinel-123456';
  t.after(async () => {
    if (old === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = old;
    delete process.env.ASSESSMENT_TEST_API_KEY;
    await rm(home, { recursive: true, force: true });
  });
  const result = await monitorAssessment(context, async () => ({
    status: 'completed',
    returnedModel: process.env.ASSESSMENT_TEST_API_KEY,
  }));
  assert.ok(!JSON.stringify(result).includes('credential-sentinel'));
  assert.equal('assessment' in result ? result.assessment.status : result.status, 'unavailable');
  assert.ok(!JSON.stringify(await assessmentHistory('alice')).includes('credential-sentinel'));
});
